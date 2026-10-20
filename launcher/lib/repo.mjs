// launcher/lib/repo.mjs — everything that touches the game's source tree:
// inspecting an install, cloning the chosen download source, updating it, and the
// tar.gz fallback for machines without git.
//
// The launcher deliberately delegates the heavy lifting (npm install, art/audio
// download) to the project's own tools (`tools/setup.mjs`, `tools/fetch-assets.mjs`,
// `tools/doctor.mjs`) so it stays in sync with upstream instead of reimplementing it.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  exists, readJson, which, hasCommand, IS_WIN, formatBytes, dirSize, runCapture, runStream, prependPath,
} from './util.mjs';
import { sourceById, installDirOf, assetRouteOf, ROOT } from './config.mjs';

// Fallbacks for a tree whose own manifests cannot be read (first deploy before the clone, damaged file).
const LEGACY_RUNTIME_PACKAGES = ['ws', 'pixi.js', 'pixi-spine', 'preact', 'htm'];
const LEGACY_VENDOR_REQUIRED = ['pixi.min.js', 'pixi-spine.js', 'preact.module.js', 'hooks.module.js', 'htm.module.js'];
// Never overwritten by an archive-based update: they hold multi-hundred-MB downloads.
const PRESERVE_ON_REPLACE = ['node_modules', '.cache', '.venv-extract', 'public/assets', 'public/fonts', 'public/vendor'];

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

/**
 * Runtime packages the install itself declares (`package.json` dependencies).
 *
 * This used to be a hardcoded list, which is exactly how 「修复安装」 could report success on a broken
 * install: upstream 0.3.1 added `acorn` and `ses`, the list did not know them, the completeness check
 * passed, npm never ran — and the server then died on `import … from 'acorn'`. Deriving the list means
 * the next dependency upstream adds is covered without a launcher release.
 */
export function runtimePackages(dir) {
  const pkg = readJson(path.join(dir, 'package.json'), null);
  const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : [];
  return deps.length ? deps : LEGACY_RUNTIME_PACKAGES;
}

/**
 * Vendor files the install's own `tools/vendor.mjs` copies into `public/vendor`, split into required and
 * optional. Parsed from its `VENDOR_FILES` table (each row is `['node_modules/…', '<name>'[, true]]`) for
 * the same reason as `runtimePackages` — 0.3.1's `ses.umd.js` / `acorn.mjs` were invisible to the old list.
 */
export function vendorFiles(dir) {
  const src = readText(path.join(dir, 'tools', 'vendor.mjs'));
  const required = [];
  const optional = [];
  if (src) {
    const re = /\[\s*['"]node_modules\/[^'"]+['"]\s*,\s*['"]([^'"]+)['"]\s*(?:,\s*(true|false))?\s*\]/g;
    for (const m of src.matchAll(re)) (m[2] === 'true' ? optional : required).push(m[1]);
  }
  return required.length ? { required, optional } : { required: LEGACY_VENDOR_REQUIRED, optional: [] };
}

/**
 * `package-lock.json` written after `node_modules/.package-lock.json` means the tree predates the declared
 * dependency set (e.g. a git update that added a package). Only meaningful when both files exist: a
 * release package may ship `node_modules` without npm's marker and must not look stale forever.
 */
function lockNewerThanInstall(dir) {
  const lock = path.join(dir, 'package-lock.json');
  const marker = path.join(dir, 'node_modules', '.package-lock.json');
  try { return fs.statSync(lock).mtimeMs > fs.statSync(marker).mtimeMs + 2000; } catch { return false; }
}

/** Declared packages that are not installed, plus whether the lock file outranks the installed tree. */
export function depsState(dir) {
  const missing = runtimePackages(dir).filter((p) => !exists(path.join(dir, 'node_modules', ...p.split('/'), 'package.json')));
  return { missing, stale: lockNewerThanInstall(dir), hasNodeModules: exists(path.join(dir, 'node_modules')) };
}

/** Absolute path of the game install for this config. */
export const gameDir = (cfg) => installDirOf(cfg);

/** Is this directory a git working copy? */
export const isGitRepo = (dir) => exists(path.join(dir, '.git'));

/** Prefer the `npm` shipped next to the running node, then fall back to PATH. */
export function npmCommand() {
  const beside = path.join(path.dirname(process.execPath), IS_WIN ? 'npm.cmd' : 'npm');
  if (exists(beside)) return beside;
  return which(IS_WIN ? 'npm.cmd' : 'npm') || which('npm');
}

/**
 * How to spawn npm so an install path with spaces survives.
 *
 * On Windows `npm` is a `.cmd` shim, which forces `shell: true` — and Node's shell mode concatenates the
 * program path without quoting, so `C:\Program Files\nodejs\npm.cmd` becomes `C:\Program`, which cmd.exe
 * rejects. Running npm's JavaScript entry point with the current node keeps `shell` off entirely.
 * @returns {{cmd:string,args:string[],shell:boolean}|null}
 */
export function npmInvocation() {
  const npm = npmCommand();
  if (!npm) return null;
  const cli = path.join(path.dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (exists(cli)) return { cmd: process.execPath, args: [cli], shell: false };
  // Fallback shim: quote it, because shell mode will not do that for us.
  return { cmd: IS_WIN ? `"${npm}"` : npm, args: [], shell: IS_WIN && /\.(cmd|bat)$/i.test(npm) };
}

export function gitCommand() { return which('git'); }

/** Accurate "how complete is public/assets" check based on data/assets.json. */
function assetStats(dir) {
  const manifestPath = path.join(dir, 'data', 'assets.json');
  const manifest = readJson(manifestPath, null);
  const publicDir = path.join(dir, 'public');
  if (!manifest || !exists(publicDir)) {
    const present = exists(path.join(dir, 'public', 'assets'));
    return { present, total: 0, sampled: 0, missing: 0, known: false };
  }
  const paths = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.startsWith('/assets/') || v.startsWith('/fonts/')) paths.add(v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') { for (const x of Object.values(v)) walk(x); }
  };
  walk(manifest);
  const all = [...paths];
  // Deterministic sample so the number is stable between refreshes.
  const sample = all.length <= 200 ? all : Array.from({ length: 200 }, (_, i) => all[Math.floor((i * all.length) / 200)]);
  let missing = 0;
  for (const rel of sample) {
    if (!exists(path.join(publicDir, rel.replace(/^\//, '')))) missing++;
  }
  return { present: exists(path.join(dir, 'public', 'assets')), total: all.length, sampled: sample.length, missing, known: true };
}

/** Describe the current install state (cheap, synchronous). */
export function inspectInstall(cfg) {
  const dir = gameDir(cfg);
  const info = {
    dir, exists: exists(dir), isRepo: false, hasPackageJson: false, packageVersion: null,
    hasNodeModules: false, missingPackages: [], depsStale: false, hasVendor: false, missingVendor: [], optionalMissingVendor: [],
    assets: { present: false, total: 0, sampled: 0, missing: 0, known: false },
    local: localArtState(dir),
    sizeBytes: 0, ready: false, hasGit: !!gitCommand(), hasTar: hasCommand('tar'),
  };
  if (!info.exists) return info;
  info.isRepo = isGitRepo(dir);
  const pkg = readJson(path.join(dir, 'package.json'), null);
  info.hasPackageJson = !!pkg;
  info.packageVersion = pkg?.version ?? null;
  const deps = depsState(dir);
  info.missingPackages = deps.missing;
  info.depsStale = deps.stale;
  info.hasNodeModules = deps.missing.length === 0;
  const vendor = vendorFiles(dir);
  info.missingVendor = vendor.required.filter((f) => !exists(path.join(dir, 'public', 'vendor', f)));
  info.optionalMissingVendor = vendor.optional.filter((f) => !exists(path.join(dir, 'public', 'vendor', f)));
  info.hasVendor = info.missingVendor.length === 0;
  info.assets = assetStats(dir);
  try { info.sizeBytes = dirSize(dir, 4000); } catch { info.sizeBytes = 0; }
  // A stale lock file is not "missing", but it is not ready either: the next start must reinstall first.
  info.ready = info.hasPackageJson && info.hasNodeModules && !info.depsStale && info.hasVendor;
  return info;
}

/** Read the git version/commit info of an install (best effort). */
export function gitInfo(dir) {
  if (!isGitRepo(dir) || !exists(dir)) return null;
  const git = gitCommand();
  if (!git) return null;
  const run = (args) => runCapture(git, ['-C', dir, ...args], { timeout: 15000 });
  const head = run(['rev-parse', 'HEAD']);
  const short = run(['rev-parse', '--short', 'HEAD']);
  const date = run(['log', '-1', '--format=%cs']);
  const subject = run(['log', '-1', '--format=%s']);
  const describe = run(['describe', '--tags', '--abbrev=0']);
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run(['status', '--porcelain']);
  // `runCapture` folds stderr into `out`, so a repository without an `origin` would otherwise report
  // the error text ("error: No such remote 'origin'") as its remote URL.
  const remote = run(['remote', 'get-url', 'origin']);
  return {
    commit: head.ok ? head.out.trim() : null,
    short: short.ok ? short.out.trim() : null,
    date: date.ok ? date.out.trim() : null,
    subject: subject.ok ? subject.out.trim() : null,
    tag: describe.ok ? describe.out.trim() : null,
    branch: branch.ok ? branch.out.trim() : null,
    dirty: status.ok ? status.out.trim().length > 0 : false,
    remote: remote.ok && remote.out.trim() ? remote.out.trim() : null,
  };
}

/** Recent commit subjects (used for the update history panel). */
export function gitLog(dir, limit = 40) {
  if (!isGitRepo(dir) || !exists(dir)) return [];
  const git = gitCommand();
  if (!git) return [];
  const r = runCapture(git, ['-C', dir, 'log', `-${limit}`, '--pretty=format:%h\x1f%cs\x1f%s\x1f%an'], { timeout: 15000 });
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((l) => {
    const [hash, date, subject, author] = l.split('\x1f');
    return { hash, date, subject, author };
  });
}

/** Commits the local install is missing, relative to a fetched ref (default FETCH_HEAD). */
export function gitIncoming(dir, ref = 'FETCH_HEAD', limit = 60) {
  if (!isGitRepo(dir) || !exists(dir)) return [];
  const git = gitCommand();
  if (!git) return [];
  const r = runCapture(git, ['-C', dir, 'log', '--pretty=format:%h\x1f%cs\x1f%s', `HEAD..${ref}`], { timeout: 15000 });
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).slice(0, limit).map((l) => {
    const [hash, date, subject] = l.split('\x1f');
    return { hash, date, subject };
  });
}

/** Parse CHANGELOG.md into `[{version, date, body}]` (newest first). */
export function parseChangelog(dir) {
  const file = path.join(dir, 'CHANGELOG.md');
  if (!exists(file)) return [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const sections = [];
  const re = /^##\s+(.+?)\s*$/gm;
  let m;
  const heads = [];
  while ((m = re.exec(text)) !== null) heads.push({ title: m[1].trim(), index: m.index, end: re.lastIndex });
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].end;
    const stop = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const title = heads[i].title;
    const vm = /^([\w.\-+]+)\s*[—–-]\s*(\S+)?/.exec(title);
    sections.push({
      version: vm ? vm[1] : title,
      date: vm && vm[2] ? vm[2] : '',
      body: text.slice(start, stop).trim(),
    });
  }
  return sections;
}

/**
 * Download a URL to a file, reporting progress through `onProgress(loaded, total)`.
 *
 * Two deadlines, because one is not enough for a big file: `timeout` bounds the wait for the response
 * headers, and `idle` bounds a stall in the middle of the body. The timer used to be cleared as soon
 * as the headers arrived, which left a transfer that stopped sending bytes hanging forever — measured
 * as a 4 KB download that took minutes because the first host answered and then went quiet.
 */
export async function downloadFile(url, dest, { onProgress, timeout = 30000, idle = 30000 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const ac = new AbortController();
  let timer = setTimeout(() => ac.abort(), timeout);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), idle); };
  let res;
  try {
    res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  // Arm the stall watchdog before the first byte, so a body that never starts also fails.
  bump();
  const total = Number(res.headers.get('content-length')) || 0;
  let loaded = 0;
  let lastReport = 0;
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (chunk) => {
    loaded += chunk.length;
    bump();
    const now = Date.now();
    if (onProgress && (now - lastReport > 500 || loaded === total)) {
      lastReport = now;
      onProgress(loaded, total);
    }
  });
  try {
    await pipeline(stream, fs.createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
  onProgress?.(loaded, total || loaded);
  return { bytes: loaded, total };
}

/** Extract a tar.gz into `destDir` using the system `tar` (bsdtar on Windows 10+). */
export function extractTar(archivePath, destDir, { stripComponents = 1 } = {}) {
  const tar = which('tar');
  if (!tar) throw new Error('系统缺少 tar，无法解压；请安装 git 后改用 git 方式下载。');
  fs.mkdirSync(destDir, { recursive: true });
  const args = ['-xzf', archivePath, '-C', destDir, `--strip-components=${stripComponents}`];
  const r = runCapture(tar, args, { timeout: 300000 });
  if (!r.ok) throw new Error(`解压失败：${r.out || r.status}`);
  return true;
}

/** Recursively copy `src` into `dst`, skipping the entries in PRESERVE_ON_REPLACE (when copying a whole tree). */
function mergeCopy(srcDir, dstDir, top = true) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (top && PRESERVE_ON_REPLACE.includes(entry.name) && exists(path.join(dstDir, entry.name))) continue;
    // Never touch a link: `public/assets` may point at the shared store (lib/installs.mjs), and copying
    // it as a file would follow the link and fail (or duplicate ~580 MB).
    if (entry.isSymbolicLink()) continue;
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) mergeCopy(s, d, false);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Install the game from a download source. Handles both the git and archive routes and
 * adopts an already-present install instead of overwriting it.
 * @param {object} cfg
 * @param {{force?:boolean, log:(line:string,stream?:string)=>void}} opts
 */
export async function installFromSource(cfg, { force = false, log = () => {} } = {}) {
  const dir = gameDir(cfg);
  const source = sourceById(cfg.downloadSource);

  if (exists(dir) && exists(path.join(dir, 'package.json')) && !force) {
    log(`检测到已有安装：${dir}（跳过下载，直接准备依赖与素材）`);
    return { adopted: true, dir };
  }
  if (exists(dir) && force) {
    // Keep heavy downloads (assets / node_modules / caches) — only replace the code.
    log('已存在安装目录：保留素材、依赖与缓存，只更新代码文件。');
  }

  const git = gitCommand();
  let cloned = false;
  if (git) {
    log(`▶ git clone（${source.label}）→ ${dir}`);
    const handle = runStream(git, ['-c', 'advice.detachedHead=false', 'clone', '--depth=1', '--branch', 'master', source.git, dir], {
      env: { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
      onLine: (_s, line) => { if (line.trim()) log(line, 'stderr'); },
    });
    const res = await handle.done;
    if (res.code === 0) cloned = true;
    else log(`git clone 失败（退出码 ${res.code}），改用压缩包方式……`, 'stderr');
  } else {
    log('未检测到 git，改用压缩包方式下载（更慢，但无需安装 git）。');
  }

  if (!cloned) {
    const tmp = path.join(ROOT, '.cache', `download-${Date.now()}.tar.gz`);
    const staging = path.join(ROOT, '.cache', `staging-${Date.now()}`);
    try {
      log(`▶ 下载源码压缩包（${formatBytes(0)} 起）…`);
      let lastPct = -1;
      await downloadFile(source.archive, tmp, {
        timeout: 60000,
        onProgress: (loaded, total) => {
          const pct = total ? Math.floor((loaded / total) * 100) : -1;
          if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
            lastPct = pct;
            log(`  下载中… ${formatBytes(loaded)}${total ? ` / ${formatBytes(total)}（${pct}%）` : ''}`);
          }
        },
      });
      log('▶ 解压…');
      extractTar(tmp, staging, { stripComponents: 1 });
      fs.mkdirSync(dir, { recursive: true });
      mergeCopy(staging, dir, true);
      log(`✔ 已解压到 ${dir}`);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } else {
    log('✔ 仓库克隆完成');
  }

  if (!exists(path.join(dir, 'package.json'))) throw new Error(`安装目录里没有 package.json：${dir}`);
  return { adopted: false, dir };
}

/**
 * Update an existing install in place.
 * @param {object} cfg
 * @param {{force?:boolean, log:(line:string,stream?:string)=>void}} opts
 */
export async function updateFromSource(cfg, { force = false, log = () => {} } = {}) {
  const dir = gameDir(cfg);
  if (!exists(dir) || !exists(path.join(dir, 'package.json'))) {
    await installFromSource(cfg, { log });
    return { mode: 'install' };
  }
  const git = gitCommand();
  if (git && isGitRepo(dir)) {
    const source = sourceById(cfg.downloadSource);
    // Fetch the chosen source's master explicitly instead of touching the repo's origin,
    // so adopting an existing checkout never rewrites the user's remotes.
    log(`▶ git fetch ${source.label}`);
    const fetch = runStream(git, ['-C', dir, 'fetch', '--no-tags', source.git, 'master'], {
      env: { GIT_TERMINAL_PROMPT: '0' },
      onLine: (_s, line) => { if (line.trim()) log(line, 'stderr'); },
    });
    const fr = await fetch.done;
    if (fr.code !== 0) throw new Error(`git fetch 失败（退出码 ${fr.code}），可在「下载源」里换一个源重试。`);
    if (force) {
      log('▶ git reset --hard FETCH_HEAD（强制覆盖本地修改）');
      const reset = runCapture(git, ['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], { timeout: 60000 });
      if (!reset.ok) throw new Error(`git reset 失败：${reset.out}`);
    } else {
      log('▶ git merge --ff-only FETCH_HEAD');
      const merge = runCapture(git, ['-C', dir, 'merge', '--ff-only', 'FETCH_HEAD'], { timeout: 60000 });
      if (!merge.ok) {
        throw new Error(`本地有改动，无法自动快进合并：${merge.out}\n可在「配置 → 更新」里勾选「强制更新（丢弃本地修改）」后重试。`);
      }
    }
    log('✔ 代码已更新到最新 master');
    return { mode: 'git' };
  }
  // Archive route (no git): download the new tree and merge it over the install, keeping heavy folders.
  log('未使用 git 安装，改用压缩包覆盖更新（保留素材与依赖）。');
  const source = sourceById(cfg.downloadSource);
  const tmp = path.join(ROOT, '.cache', `update-${Date.now()}.tar.gz`);
  const staging = path.join(ROOT, '.cache', `update-staging-${Date.now()}`);
  try {
    let lastPct = -1;
    await downloadFile(source.archive, tmp, {
      timeout: 60000,
      onProgress: (loaded, total) => {
        const pct = total ? Math.floor((loaded / total) * 100) : -1;
        if (pct !== lastPct && (pct % 10 === 0 || pct === 100)) { lastPct = pct; log(`  下载中… ${formatBytes(loaded)}${total ? `（${pct}%）` : ''}`); }
      },
    });
    extractTar(tmp, staging, { stripComponents: 1 });
    mergeCopy(staging, dir, true);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  log('✔ 已用最新压缩包覆盖代码（素材、依赖与缓存保留）');
  return { mode: 'archive' };
}

// ------------------------------------------------------------------------------------------------
// Art / audio assets
// ------------------------------------------------------------------------------------------------

/**
 * The line the game's `tools/fetch-assets.mjs` prints when its manifest shrink guard refuses to write
 * `data/assets.json` (docs/ASSETS.md "The manifest never shrinks by accident"): the rebuilt manifest
 * would lose entries the committed one still has. On an existing checkout that happens when the cached
 * upstream indexes (`charword_table.json`, `audio_data.json`, `models_data.json` under `.cache/`) predate
 * an operator or model the game update added, so the plan cannot reproduce their audio entries.
 */
export const ASSET_SHRINK_RE = /NOT written — it would lose \d+ entries/;

/**
 * Did the game's last `tools/fetch-assets.mjs` run keep the committed manifest? `tools/setup.mjs` only
 * warns when the asset download fails, so its report (`.cache/assets-report.json`) is the cheapest way
 * to tell "assets still incomplete" from "assets fine" after it ran.
 * @param {string} dir game install directory
 */
export function assetManifestHeld(dir) {
  return readJson(path.join(dir, '.cache', 'assets-report.json'), null)?.manifestWritten === false;
}

/**
 * The optional official art extracted from a locally installed Arknights client (docs/DEPLOY.md §6):
 * `data/local-assets.json` + `public/assets/local/`. Mirrors the game's own `checkLocal()`
 * (tools/setup.mjs) so the launcher reports the same thing setup does. Absent art is not a failure —
 * the game falls back to the 2D board and stand-in icons — so this only drives a status row and
 * whether a deploy asks setup to extract.
 * @param {string} dir game install directory
 */
export function localArtState(dir) {
  const m = readJson(path.join(dir, 'data', 'local-assets.json'), null);
  const groups = m?.groups && typeof m.groups === 'object' ? m.groups : null;
  const count = groups ? Object.values(groups).reduce((n, g) => n + Object.keys(g || {}).length, 0) : 0;
  const hasGroup = (prefix) => !!groups && Object.keys(groups).some((g) => g.startsWith(prefix));
  const publicDir = path.join(dir, 'public', 'assets', 'local');
  return {
    manifest: !!m,
    count,
    dirPresent: exists(publicDir),
    board3d: exists(path.join(publicDir, 'map', 'autochess', 'TX_autochessi_D.png')),
    tiles: exists(path.join(publicDir, 'map', 'autochess', 'tiles.json')),
    enemySpines: hasGroup('spine/enemy/'),
    tokenSpines: hasGroup('spine/token/'),
  };
}

/**
 * The `tools/setup.mjs` flags that express the client-art settings (docs/DEPLOY.md §6). The game's
 * step 6 has four modes, so the choice is a small state machine:
 *   extractLocal off            → `--no-local`
 *   art already extracted       → `--yes`   (report the count; `--local` would re-extract every time)
 *   art missing, a path is set  → `--local --game <dir>`  (`--game` implies a forced extraction)
 *   art missing, auto-detect    → `--local` (setup.mjs probes the usual install locations)
 * @param {object} cfg launcher config (`extractLocal`, `clientDir`)
 * @param {boolean} artPresent whether `data/local-assets.json` is already there
 */
export function localExtractArgs(cfg, artPresent) {
  // `extractLocal` unset counts as on, matching DEFAULT_CONFIG (a caller that passes a bare object
  // should get the same behaviour as the launcher's own defaults).
  if (cfg?.extractLocal === false) return ['--no-local'];
  if (artPresent) return ['--yes'];
  return cfg?.clientDir ? ['--local', '--game', cfg.clientDir] : ['--local'];
}

/**
 * Does this version track `data/assets.json` in git? Forks that add content commit their own manifest,
 * and it lists entries the public mirrors do not have (their own art, or client-only models). Rebuilding
 * the manifest from the mirrors can therefore never reproduce it — so the tool's shrink guard will keep
 * refusing and retrying changes nothing.
 */
function ownsAssetManifest(dir) {
  if (!isGitRepo(dir) || !gitCommand()) return false;
  const r = runCapture(gitCommand(), ['-C', dir, 'ls-files', '--error-unmatch', 'data/assets.json'], { timeout: 15000 });
  return r.ok && /assets\.json/.test(r.out);
}

/**
 * Sync the game's art / audio by running `tools/fetch-assets.mjs`, healing the two failures the tool
 * reports on an existing install:
 *   1. the manifest shrink guard — a stale `.cache/` upstream index that predates an operator the game
 *      update added, so the plan cannot reproduce her audio entries (`--refresh-index` is the remedy
 *      the tool prints itself);
 *   2. downloads that fail on a direct connection to GitHub — retried through the GitHub mirror
 *      (`--asset-source=mirror`), which is what the tool tells the user to do by hand.
 * A fresh index and plenty of bandwidth cost nothing extra: every step only runs after a failed one.
 *
 * The one case that must NOT be retried: a version whose manifest is its own (see `ownsAssetManifest`).
 * There the guard is permanent — the missing entries are not on any mirror — and retrying only burns
 * minutes (measured: three full passes over ~10k files, ~26 minutes, downloading nothing on the last).
 * @param {object} cfg launcher config (`installDir`, `assetConcurrency`, `downloadSource`)
 * @param {{log?:(line:string,stream?:string)=>void, trackChild?:(handle:any)=>void, isCancelled?:()=>boolean}} [o]
 *   `trackChild` hands the running child over so the task runner's cancel can still kill it;
 *   `isCancelled` suppresses the retries after the user cancelled.
 * @returns {Promise<{ok:boolean, code:number, refreshed:boolean, mirrored:boolean, ownedManifest:boolean}>}
 */
export async function syncAssets(cfg, { log = () => {}, trackChild = () => {}, isCancelled = () => false } = {}) {
  const dir = gameDir(cfg);
  const route = assetRouteOf(cfg);
  const attempt = async (route, args) => {
    const lines = [];
    const env = prependPath(path.dirname(process.execPath));
    if (route.proxy) env.SP_GITHUB_PROXY = route.proxy;
    const handle = runStream(process.execPath, [
      path.join('tools', 'fetch-assets.mjs'),
      `--concurrency=${cfg.assetConcurrency || 16}`,
      `--asset-source=${route.source}`,
      ...args,
    ], {
      cwd: dir,
      env,
      onLine: (stream, line) => { lines.push(line); log(line, stream); },
    });
    trackChild(handle);
    try {
      const res = await handle.done;
      if (res.error) throw res.error;
      return { code: res.code, text: lines.join('\n') };
    } finally {
      trackChild(null);
    }
  };

  // Is this version's manifest its own? Decided before the first run, so a permanent guard is reported
  // as such instead of being retried.
  const ownedManifest = ownsAssetManifest(dir);

  let r = await attempt(route, []);
  let refreshed = false;
  if (r.code !== 0 && !isCancelled() && ASSET_SHRINK_RE.test(r.text)) {
    if (ownedManifest) {
      log('这个版本自带 data/assets.json（含公开镜像没有的条目），清单保护会一直触发；已保留它的清单，不再重试。', 'meta');
      return { ok: false, code: r.code, refreshed: false, mirrored: false, ownedManifest: true };
    }
    log('素材清单将缩小 —— 本地的上游索引可能已过期（游戏更新新增了干员 / 模型）。重新拉取索引后重试…', 'meta');
    refreshed = true;
    r = await attempt(route, ['--refresh-index']);
  }
  let mirrored = false;
  if (r.code !== 0 && !isCancelled() && route.source === 'direct') {
    log('直连 GitHub 未能下完素材；改用 GitHub 镜像（--asset-source=mirror）重试…', 'meta');
    mirrored = true;
    // --refresh-index again: the index download may have been what the blocked network stopped above.
    r = await attempt({ source: 'mirror' }, ['--refresh-index']);
  }
  return { ok: r.code === 0, code: r.code, refreshed, mirrored, ownedManifest };
}
