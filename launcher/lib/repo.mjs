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
  exists, readJson, which, hasCommand, IS_WIN, formatBytes, dirSize, runCapture, runStream,
} from './util.mjs';
import { sourceById, installDirOf, ROOT } from './config.mjs';

const RUNTIME_PACKAGES = ['ws', 'pixi.js', 'pixi-spine', 'preact', 'htm'];
const VENDOR_REQUIRED = ['pixi.min.js', 'pixi-spine.js', 'preact.module.js', 'hooks.module.js', 'htm.module.js'];
// Never overwritten by an archive-based update: they hold multi-hundred-MB downloads.
const PRESERVE_ON_REPLACE = ['node_modules', '.cache', '.venv-extract', 'public/assets', 'public/fonts', 'public/vendor'];

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
    hasNodeModules: false, missingPackages: [], hasVendor: false, missingVendor: [],
    assets: { present: false, total: 0, sampled: 0, missing: 0, known: false },
    sizeBytes: 0, ready: false, hasGit: !!gitCommand(), hasTar: hasCommand('tar'),
  };
  if (!info.exists) return info;
  info.isRepo = isGitRepo(dir);
  const pkg = readJson(path.join(dir, 'package.json'), null);
  info.hasPackageJson = !!pkg;
  info.packageVersion = pkg?.version ?? null;
  info.missingPackages = RUNTIME_PACKAGES.filter((p) => !exists(path.join(dir, 'node_modules', ...p.split('/'), 'package.json')));
  info.hasNodeModules = info.missingPackages.length === 0;
  info.missingVendor = VENDOR_REQUIRED.filter((f) => !exists(path.join(dir, 'public', 'vendor', f)));
  info.hasVendor = info.missingVendor.length === 0;
  info.assets = assetStats(dir);
  try { info.sizeBytes = dirSize(dir, 4000); } catch { info.sizeBytes = 0; }
  info.ready = info.hasPackageJson && info.hasNodeModules && info.hasVendor;
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
  return {
    commit: head.ok ? head.out.trim() : null,
    short: short.ok ? short.out.trim() : null,
    date: date.ok ? date.out.trim() : null,
    subject: subject.ok ? subject.out.trim() : null,
    tag: describe.ok ? describe.out.trim() : null,
    branch: branch.ok ? branch.out.trim() : null,
    dirty: status.ok ? status.out.trim().length > 0 : false,
    remote: (run(['remote', 'get-url', 'origin']).out || '').trim() || null,
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

/** Download a URL to a file, reporting progress through `onProgress(loaded, total)`. */
export async function downloadFile(url, dest, { onProgress, timeout = 30000 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let loaded = 0;
  let lastReport = 0;
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (chunk) => {
    loaded += chunk.length;
    const now = Date.now();
    if (onProgress && (now - lastReport > 500 || loaded === total)) {
      lastReport = now;
      onProgress(loaded, total);
    }
  });
  await pipeline(stream, fs.createWriteStream(dest));
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
