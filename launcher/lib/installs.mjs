// launcher/lib/installs.mjs — the version registry: many full game installs side by side.
//
// The model is "one folder per version, one copy of the art". A version is a plain checkout of either
// upstream or somebody's fork — nothing is patched onto it:
//
//   installs/<id>/           git clone --depth=1 of <repo> at <ref>; one version, self-contained code
//   shared/public/assets     the ~580 MB of official art / audio, downloaded once
//   shared/public/fonts
//
// and each version's `public/assets` and `public/fonts` are links into `shared/`, so N versions cost
// N × ~55 MB instead of N × ~640 MB. Sharing is safe because of what the art actually is:
//
//   * no fork keeps asset files in git (measured: 0 tracked files under public/assets or public/fonts),
//     so the shared copy is never overridden by a fork;
//   * every fork's manifest is a strict superset of upstream's (measured: +0 … +361 paths, never a
//     removal) and the added paths are official IDs under their own directory, and the forks' added
//     sets are disjoint — so the shared store is a safe union.
//
// Linking degrades rather than failing: symlink → Windows junction (no admin needed) → a real copy →
// no link at all (that version downloads its own art). `shareAssets: false` skips linking entirely.

import fs from 'node:fs';
import path from 'node:path';
import { INSTALLS_DIR, sharedDirOf, gitUrlCandidates } from './config.mjs';
import { exists, readJson, mkdirp, runCapture, IS_WIN, dirSize } from './util.mjs';
import { gitCommand, isGitRepo, gitInfo } from './repo.mjs';

/** The subdirectories of `public/` that every version shares (the big, downloaded ones). */
export const SHARED_SUBDIRS = ['assets', 'fonts'];

/** A version id from a repo/ref pair: stable, filesystem-safe, and readable in the folder name. */
export function installIdFor(repo, ref) {
  const slug = String(repo || '').replace(/\.git$/, '').split('/').filter(Boolean).slice(-2).join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const r = String(ref || 'default').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const id = `${slug || 'install'}--${r || 'default'}`.slice(0, 64);
  return id || `install-${Date.now().toString(36)}`;
}

/** Where a version's folder lives. */
export const installDirFor = (id) => path.join(INSTALLS_DIR, id);

const dirExists = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Read a symlink/junction's target, or null. */
function linkTarget(p) {
  try { return fs.readlinkSync(p); } catch { return null; }
}

/** Non-empty directory? */
function hasEntries(p) {
  try { return dirExists(p) && fs.readdirSync(p).length > 0; } catch { return false; }
}

/**
 * Size of an install's own files, NOT counting what a linked subdirectory points at (otherwise every
 * version would report the shared art as its own).
 */
function ownSize(dir, budget = 3000) {
  let total = 0;
  const started = Date.now();
  const walk = (d) => {
    if (Date.now() - started > budget) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { try { total += fs.statSync(full).size; } catch { /* race */ } }
    }
  };
  walk(dir);
  return total;
}

// ------------------------------------------------------------------------------------------------
// The shared store
// ------------------------------------------------------------------------------------------------

export const sharedPublicDir = (cfg) => path.join(sharedDirOf(cfg), 'public');

/** Create the shared store's skeleton (idempotent). */
export function ensureShared(cfg) {
  const base = sharedPublicDir(cfg);
  mkdirp(base);
  for (const sub of SHARED_SUBDIRS) mkdirp(path.join(base, sub));
  return base;
}

/** How big the shared store is, and whether it holds anything yet. */
export function sharedStatus(cfg) {
  const cfgDir = sharedDirOf(cfg);
  const publicDir = sharedPublicDir(cfg);
  const out = { dir: cfgDir, publicDir, exists: dirExists(publicDir), bytes: 0, files: 0, populated: false };
  if (!out.exists) return out;
  for (const sub of SHARED_SUBDIRS) {
    const d = path.join(publicDir, sub);
    if (!dirExists(d)) continue;
    out.bytes += dirSize(d, 5000);
    try { out.files += fs.readdirSync(d).length; } catch { /* ignore */ }
  }
  out.populated = hasEntries(path.join(publicDir, 'assets'));
  return out;
}

/**
 * Move (or copy) whatever a version already downloaded into the shared store, then remove it from the
 * version. This is what makes switching an *existing* install over cheap: its ~580 MB is adopted
 * rather than downloaded again. Rows that already exist in the shared store are left alone.
 */
function adoptIntoShared(cfg, installDir, log = () => {}) {
  const publicDir = sharedPublicDir(cfg);
  mkdirp(publicDir);
  for (const sub of SHARED_SUBDIRS) {
    const src = path.join(installDir, 'public', sub);
    const dst = path.join(publicDir, sub);
    mkdirp(dst);
    if (!hasEntries(src) || isLink(src)) continue;
    // Same volume → rename is instant; a cross-volume move throws EXDEV, then we copy.
    try {
      if (!hasEntries(dst)) {
        fs.rmdirSync(dst);
        fs.renameSync(src, dst);
        log(`   已把 ${sub} 收纳进共享区（移动）`, 'stdout');
        continue;
      }
    } catch { /* fall through to a merge */ }
    let moved = 0;
    const walk = (from, to) => {
      mkdirp(to);
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const f = path.join(from, e.name);
        const t = path.join(to, e.name);
        if (e.isDirectory()) { walk(f, t); continue; }
        if (!e.isFile() || exists(t)) continue;
        try { fs.copyFileSync(f, t); moved++; } catch { /* best effort */ }
      }
    };
    walk(src, dst);
    try { fs.rmSync(src, { recursive: true, force: true }); } catch { /* best effort */ }
    log(`   已把 ${sub} 收纳进共享区（合并 ${moved} 个文件）`, 'stdout');
  }
}

// ------------------------------------------------------------------------------------------------
// Linking one version's art to the shared store
// ------------------------------------------------------------------------------------------------

/**
 * Point `<install>/public/<sub>` at `<shared>/public/<sub>`, degrading instead of failing.
 * @param {{log?:Function, move?:boolean}} [o] `move: false` refuses to relocate art the version already
 *   has on disk — only a link that needs no data movement is created. Adopting an existing install must
 *   not silently move ~580 MB out of a folder the user has been using; the 「重建素材链接」 action asks
 *   for that explicitly.
 * @returns {'symlink'|'junction'|'copy'|'own'|'pending'|'skipped'} how the version gets its art
 */
function linkOne(cfg, installDir, sub, { log = () => {}, move = true } = {}) {
  const target = path.join(sharedPublicDir(cfg), sub);
  const link = path.join(installDir, 'public', sub);

  // Already a link? Make sure it points where we want and stop.
  if (isLink(link)) {
    const to = linkTarget(link);
    if (to && path.resolve(path.dirname(link), to) === path.resolve(target)) {
      return IS_WIN && /^[A-Za-z]:/.test(to) ? 'junction' : 'symlink';
    }
    try { fs.unlinkSync(link); } catch { /* recreate below */ }
  } else if (dirExists(link) && hasEntries(link)) {
    if (!move) return 'pending';
    // A real folder here (the version downloaded its own art): adopt it, then link.
    adoptIntoShared(cfg, installDir, log);
  }

  mkdirp(target);
  mkdirp(path.dirname(link));
  if (dirExists(link)) { try { fs.rmSync(link, { recursive: true, force: true }); } catch { /* best effort */ } }

  // 1) symlink — a directory junction on Windows, which needs no administrator rights.
  try {
    fs.symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
    return IS_WIN ? 'junction' : 'symlink';
  } catch { /* fall through */ }

  // 2) the mklink command, in case the runtime refused but the OS would allow it.
  if (IS_WIN) {
    const r = runCapture('cmd', ['/c', 'mklink', '/J', link, target], { timeout: 15000 });
    if (r.ok && dirExists(link)) return 'junction';
  }

  // 3) a plain copy of whatever the shared store holds (no link support on this machine).
  if (hasEntries(target)) {
    try {
      fs.cpSync(target, link, { recursive: true });
      log(`   ${IS_WIN ? 'Windows 不支持目录链接' : '本机不支持符号链接'}：已改为复制一份 ${sub}`, 'meta');
      return 'copy';
    } catch { /* fall through */ }
  }

  // 4) nothing worked (or nothing to copy yet): this version will download its own art.
  log(`   无法为 ${sub} 建立共享链接，该版本将自行下载素材（占用更多磁盘）`, 'stderr');
  return 'own';
}

/**
 * Apply the sharing setting to one version.
 * @param {{log?:Function, move?:boolean}} [o]
 * @returns {{mode:string, shared:boolean}}
 */
export function linkInstallAssets(cfg, installDir, { log = () => {}, move = true } = {}) {
  if (!cfg.shareAssets) return { mode: 'skipped', shared: false };
  if (!dirExists(installDir)) return { mode: 'skipped', shared: false };
  ensureShared(cfg);
  const modes = SHARED_SUBDIRS.map((sub) => linkOne(cfg, installDir, sub, { log, move }));
  const pick = (order) => order.find((m) => modes.includes(m));
  const mode = pick(['pending', 'own', 'copy', 'symlink', 'junction']) || 'skipped';
  return { mode, shared: !modes.some((m) => m === 'own' || m === 'pending') };
}

/** Remove this version's links (used before deleting a version — never touches the shared store). */
export function unlinkInstallAssets(installDir) {
  for (const sub of SHARED_SUBDIRS) {
    const link = path.join(installDir, 'public', sub);
    if (isLink(link)) { try { fs.unlinkSync(link); } catch { /* best effort */ } }
  }
}

// ------------------------------------------------------------------------------------------------
// The registry
// ------------------------------------------------------------------------------------------------

const gitRun = (dir, args, timeout = 120000) => runCapture(gitCommand(), ['-C', dir, ...args], { timeout, env: { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' } });

/**
 * `git`'s message for a ref that does not exist on the remote. Telling these apart from a connection
 * failure matters: every mirror reports the same thing, so "tried 5 addresses" would be a lie.
 */
const isMissingRefError = (out) => /Remote branch .* not found|Couldn't find remote ref|not our ref/i.test(String(out || ''));

/**
 * One clone/fetch attempt may not run longer than this. A blocked host does not fail fast — it idles on
 * the OS connect timeout (75 s on macOS) — so the attempt has to be cut off by us.
 */
const GIT_ATTEMPT_TIMEOUT_MS = 90000;
/** Total wall clock for one chain of attempts, so a dead network cannot keep a task busy for minutes. */
const GIT_ATTEMPT_BUDGET_MS = 240000;
/** Probes (`ls-remote`, the startup update check) are frequent and must stay cheap. */
const GIT_PROBE_TIMEOUT_MS = 25000;
const GIT_PROBE_BUDGET_MS = 60000;

/** Abort a transfer that stalls once connected, on top of our own per-attempt timeout. */
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_LFS_SKIP_SMUDGE: '1',
  GIT_HTTP_LOW_SPEED_LIMIT: '1000',
  GIT_HTTP_LOW_SPEED_TIME: '30',
};

/**
 * Run `attempt(url, timeoutMs)` against every candidate URL for `repo` until one succeeds. The
 * candidates come from `gitUrlCandidates`, i.e. the configured download source's proxy first for a
 * fork, so a mirrored user never waits on the unreachable direct URL.
 * @param {object} cfg launcher config (`downloadSource`)
 * @param {string} repo the version's recorded repository URL
 * @param {(line:string, stream?:string)=>void} log
 * @param {{timeoutMs:number, budgetMs:number, attempt:(url:string, timeoutMs:number)=>object}} o
 * @returns {{ok:boolean, out:string, url:string, tried?:number}} `tried` is set on failure.
 */
function withUrlFallback(cfg, repo, log, o) {
  const urls = gitUrlCandidates(cfg, repo);
  const startedAt = Date.now();
  let last = { ok: false, out: '', url: '' };
  for (let i = 0; i < urls.length; i += 1) {
    if (i > 0) log(`↻ 上一个地址没成功，改用：${urls[i]}`, 'meta');
    last = { ...o.attempt(urls[i], o.timeoutMs), url: urls[i] };
    if (last.ok) return last;
    if (i + 1 < urls.length && Date.now() - startedAt > o.budgetMs) {
      log('已超过尝试镜像的时间上限，停止重试。', 'meta');
      break;
    }
  }
  return { ...last, tried: urls.length };
}

/** What the UI needs to show for one version (cheap; called for every entry on each state push). */
export function installStatus(cfg, entry) {
  const dir = entry.dir;
  const out = {
    ...entry,
    exists: dirExists(dir),
    isRepo: false,
    packageVersion: null,
    hasNodeModules: false,
    assetsPresent: false,
    assetsLinked: false,
    linkTargetOk: false,
    sizeBytes: 0,
  };
  if (!out.exists) return out;
  out.isRepo = isGitRepo(dir);
  out.packageVersion = readJson(path.join(dir, 'package.json'), null)?.version ?? null;
  out.hasNodeModules = exists(path.join(dir, 'node_modules', 'ws', 'package.json'));
  const assets = path.join(dir, 'public', 'assets');
  out.assetsPresent = dirExists(assets) && hasEntries(assets);
  out.assetsLinked = isLink(assets);
  if (out.assetsLinked) {
    const to = linkTarget(assets);
    out.linkTargetOk = !!to && path.resolve(path.dirname(assets), to) === path.resolve(path.join(sharedPublicDir(cfg), 'assets'));
  }
  try { out.sizeBytes = ownSize(dir); } catch { out.sizeBytes = 0; }
  return out;
}

/** Every version, with its live status. */
export const listInstalls = (cfg) => (cfg.installs || []).map((e) => installStatus(cfg, e));

/** Clone `<repo>` at `<ref>` into the version's folder. */
export function cloneInstall(dir, repo, ref, { cfg, log = () => {} } = {}) {
  if (!gitCommand()) throw new Error('需要 git 才能安装版本：请先安装 git。');
  if (dirExists(dir) && hasEntries(dir)) throw new Error(`目录已存在且非空：${dir}`);
  mkdirp(path.dirname(dir));
  const flags = ['-c', 'advice.detachedHead=false', 'clone', '--depth=1'];
  if (ref) flags.push('--branch', ref);
  flags.push('--single-branch');
  const r = withUrlFallback(cfg, repo, log, {
    timeoutMs: GIT_ATTEMPT_TIMEOUT_MS,
    budgetMs: GIT_ATTEMPT_BUDGET_MS,
    attempt: (url, timeoutMs) => {
      log(`▶ git clone ${ref ? `（${ref}）` : ''}${url}`, 'meta');
      // A killed attempt can leave a partial checkout that would block the next one.
      try { if (dirExists(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      return runCapture(gitCommand(), [...flags, url, dir], { timeout: timeoutMs, env: GIT_ENV });
    },
  });
  if (!r.ok) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    const why = (r.out || '').split('\n').slice(0, 4).join(' ').slice(0, 300);
    throw new Error(isMissingRefError(r.out)
      ? `这个仓库里没有「分支或标签」${ref || 'master'}：请确认「分支或标签」填写正确。${why}`
      : `git clone 失败（已尝试 ${r.tried || 1} 个地址，含当前下载源与公共镜像）：${why}`);
  }
  if (!exists(path.join(dir, 'package.json'))) throw new Error(`克隆完成，但目录里没有 package.json：${dir}`);
  return dir;
}

/** Update a version in place from its own repository and ref. */
export function updateInstall(cfg, entry, { force = false, log = () => {} } = {}) {
  const dir = entry.dir;
  if (!entry.repo) throw new Error('这个版本没有记录来源仓库，无法更新（可用「重新安装」代替）。');
  const ref = entry.ref || 'master';
  const f = withUrlFallback(cfg, entry.repo, log, {
    timeoutMs: GIT_ATTEMPT_TIMEOUT_MS,
    budgetMs: GIT_ATTEMPT_BUDGET_MS,
    attempt: (url, timeoutMs) => {
      log(`▶ git fetch ${url} ${ref}`, 'meta');
      return runCapture(gitCommand(), ['-C', dir, 'fetch', '--no-tags', url, ref], { timeout: timeoutMs, env: GIT_ENV });
    },
  });
  if (!f.ok) {
    const why = (f.out || '').split('\n')[0];
    throw new Error(isMissingRefError(f.out)
      ? `这个仓库里没有「分支或标签」${ref}：请确认「分支或标签」填写正确。${why}`
      : `git fetch 失败（已尝试 ${f.tried || 1} 个地址，含当前下载源与公共镜像）：${why}`);
  }
  const next = gitRun(dir, ['rev-parse', 'FETCH_HEAD'], 30000).out.trim();
  const head = gitRun(dir, ['rev-parse', 'HEAD'], 30000).out.trim();
  if (next && head === next) { log('✔ 已是最新提交', 'stdout'); return { changed: false, commit: head }; }
  const merge = force ? gitRun(dir, ['reset', '--hard', 'FETCH_HEAD'], 60000) : gitRun(dir, ['merge', '--ff-only', 'FETCH_HEAD'], 60000);
  if (!merge.ok) {
    throw new Error(
      '无法自动快进合并：这个版本有本地改动，或上游被改写过。\n'
      + '可在「版本」页勾选「强制更新（丢弃该版本的本地改动）」后重试。',
    );
  }
  const after = gitRun(dir, ['rev-parse', 'HEAD'], 30000).out.trim();
  log(`✔ 已更新到 ${after.slice(0, 8)}`, 'stdout');
  return { changed: true, commit: after };
}

/**
 * Check one version against its own repository and ref — the replacement for the old "compare the
 * install against the selected download source", which was wrong the moment versions could come from
 * different forks.
 *
 * `git ls-remote` first (no fetch) to see whether the tip differs; only then does it fetch, which is what
 * lets it say "behind" vs "diverged" and list the incoming commits.
 * @param {object} entry a version from the registry
 * @param {{log?:(line:string)=>void}} [o]
 * @returns {{state:'equal'|'behind'|'diverged'|'unknown'|'norepo', local:string|null, remote:string|null, incoming:Array<{hash:string,subject:string,date:string}>}}
 */
export function checkInstallUpdate(entry, cfg, { log = () => {} } = {}) {
  const out = { state: 'unknown', local: null, remote: null, incoming: [] };
  if (!entry?.dir || !dirExists(entry.dir) || !isGitRepo(entry.dir)) return { ...out, state: 'unknown' };
  if (!entry.repo) return { ...out, state: 'norepo' };
  const git = gitCommand();
  if (!git) return out;
  const ref = entry.ref || 'master';
  out.local = gitRun(entry.dir, ['rev-parse', 'HEAD'], 20000).out.trim() || null;

  const ls = withUrlFallback(cfg, entry.repo, log, {
    timeoutMs: GIT_PROBE_TIMEOUT_MS,
    budgetMs: GIT_PROBE_BUDGET_MS,
    attempt: (url, timeoutMs) => runCapture(git, ['ls-remote', url, `refs/heads/${ref}`, `refs/tags/${ref}`], { timeout: timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' } }),
  });
  if (!ls.ok) { log(`ls-remote 失败：${(ls.out || '').split('\n')[0].slice(0, 160)}`); return out; }
  const remote = (ls.out.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '').split(/\s+/)[0] || null;
  if (!remote) { log(`远端没有 ${ref} 这个分支或标签。`); return out; }
  out.remote = remote;
  if (remote === out.local) return { ...out, state: 'equal' };

  // Different tips: fetch so we can tell "behind" from "diverged" and count the commits.
  const f = withUrlFallback(cfg, entry.repo, log, {
    timeoutMs: GIT_PROBE_TIMEOUT_MS,
    budgetMs: GIT_PROBE_BUDGET_MS,
    attempt: (url, timeoutMs) => runCapture(git, ['-C', entry.dir, 'fetch', '--no-tags', url, ref], { timeout: timeoutMs, env: GIT_ENV }),
  });
  if (!f.ok) { log(`fetch 失败：${(f.out || '').split('\n')[0].slice(0, 160)}`); return out; }
  const fetched = gitRun(entry.dir, ['rev-parse', 'FETCH_HEAD'], 20000).out.trim();
  if (!fetched) return out;
  out.remote = fetched;
  const behind = gitRun(entry.dir, ['rev-list', '--count', `HEAD..${fetched}`], 20000);
  const ahead = gitRun(entry.dir, ['rev-list', '--count', `${fetched}..HEAD`], 20000);
  const nBehind = behind.ok ? Number(behind.out.trim()) || 0 : 0;
  const nAhead = ahead.ok ? Number(ahead.out.trim()) || 0 : 0;
  if (nBehind === 0 && nAhead === 0) return { ...out, state: 'equal' };
  if (nAhead > 0 && nBehind > 0) return { ...out, state: 'diverged' };
  if (nAhead > 0) return { ...out, state: 'ahead' };
  out.state = 'behind';
  // The fetch already happened, so listing what is coming is essentially free.
  const g = gitRun(entry.dir, ['log', '--pretty=format:%h\x1f%cs\x1f%s', `HEAD..${fetched}`], 30000);
  if (g.ok) {
    out.incoming = g.out.split('\n').filter(Boolean).slice(0, 40).map((l) => {
      const [hash, date, subject] = l.split('\x1f');
      return { hash, date, subject };
    });
  }
  return out;
}

/** Delete a version's folder (never the shared store). */
export function deleteInstall(entry, { log = () => {} } = {}) {
  if (!dirExists(entry.dir)) return { ok: true, already: true };
  unlinkInstallAssets(entry.dir);
  log(`▶ 删除版本目录：${entry.dir}`, 'meta');
  fs.rmSync(entry.dir, { recursive: true, force: true });
  return { ok: true };
}

/** Fill in the commit a freshly installed version sits at. */
export function recordCommit(entry) {
  const info = isGitRepo(entry.dir) ? gitInfo(entry.dir) : null;
  return info?.commit || '';
}

/**
 * Used by the migration so an adopted folder keeps its origin/ref.
 *
 * Prefers `origin` but falls back to any remote: mirrors are common (a Gitee remote named `gitee` is the
 * norm for this project's users), and losing it would leave the version unable to update itself.
 */
export function describeRepo(dir) {
  if (!isGitRepo(dir)) return { repo: '', ref: '' };
  const git = gitCommand();
  if (!git) return { repo: '', ref: '' };
  const run = (...args) => runCapture(git, ['-C', dir, ...args], { timeout: 15000 });
  const clean = (v) => {
    const s = String(v || '').trim();
    return /^[\w.@:/~-]+$/.test(s) && s.length < 300 ? s : '';
  };
  let remote = clean(run('remote', 'get-url', 'origin').ok ? run('remote', 'get-url', 'origin').out : '');
  if (!remote) {
    const names = (run('remote').out || '').split('\n').map((s) => s.trim()).filter(Boolean).sort();
    const first = names.find((n) => n === 'upstream') || names[0];
    if (first) remote = clean(run('remote', 'get-url', first).out);
  }
  const info = gitInfo(dir);
  const ref = info?.branch && info.branch !== 'HEAD' ? info.branch : '';
  return { repo: remote, ref };
}
