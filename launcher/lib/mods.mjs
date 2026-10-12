// launcher/lib/mods.mjs — the mod manager.
//
// A mod is a customization somebody made to the *game's source* (a fork). Upstream's content packs
// (docs/PACKS.md) load data only and ship no loader for third-party code, and we do not own upstream,
// so a mod cannot be merged into a running server at load time. Instead we package each fork **once**,
// against one pinned upstream base, in our own relay repository (config.mjs `modsRepoUrl`), and this
// module replays the chosen ones onto a clean checkout:
//
//   1. `git checkout -- .`            put the install back to the pinned base,
//   2. apply the chosen mods in `order`:
//        patch   — `git apply` a series (`git format-patch` output; one mod = one fork's commits)
//        overlay — copy the files the manifest names
//      (a `profile` entry is a whole fork shipped as its own install: listed, never applied)
//   3. record what was applied in `.cache/mods.lock.json` — the ids, the versions and the files the
//      mods *added* — so 「还原为原版」 can undo it exactly and an update can refuse a modded install.
//
// The catalog lives in `<modsRepoUrl>/index.json` (branch `main`); every path in it is relative to
// that repository and is fetched through raw.githubusercontent.com, with the same public mirrors the
// download sources use (config.mjs SOURCES) when GitHub is unreachable.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import {
  exists, readJson, writeJsonAtomic, mkdirp, runCapture, fetchWithTimeout, nowIso,
} from './util.mjs';
import { gameDir, gitCommand, isGitRepo, downloadFile } from './repo.mjs';
import { toHttpsUrl, rawBase } from './selfupdate.mjs';

/** Branch of the relay repository the catalog is read from. */
export const MODS_BRANCH = 'main';
/** The catalog file inside the relay repository. */
export const MODS_INDEX = 'index.json';

const CACHE_DIR = path.join(ROOT, '.cache');
const CATALOG_FILE = path.join(CACHE_DIR, 'mods-index.json');
const SEEN_FILE = path.join(CACHE_DIR, 'mods-seen.json');
const LOCK_FILE = path.join(CACHE_DIR, 'mods.lock.json');
const DOWNLOAD_DIR = path.join(CACHE_DIR, 'mods');

/**
 * The mod kinds. `applicable: false` kinds are listed in the UI but cannot be applied to this
 * install — a whole fork is a different server, not a layer on top of this one.
 */
export const MOD_KINDS = Object.freeze({
  patch: { label: '补丁', applicable: true, summary: '按序 git apply 的补丁序列（git format-patch 的产物）' },
  overlay: { label: '覆盖', applicable: true, summary: '把清单里的文件复制进安装目录' },
  profile: { label: '整份 fork', applicable: false, summary: '独立发行的完整服务器，需单独安装，不能与本机其他模组叠加' },
});

/** Public raw mirrors, tried in order (`prefix ''` = direct). Same idea as the download sources. */
const MIRRORS = [
  { id: 'direct', prefix: '' },
  { id: 'ghproxy', prefix: 'https://gh-proxy.com/' },
  { id: 'ghfast', prefix: 'https://ghfast.top/' },
];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const MOD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A relative path we may write inside the install (no absolute, no `..`, no drive/backslash). */
export function isSafeRel(rel) {
  const s = String(rel || '');
  if (!s || s.length > 200 || s.includes('\\') || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false;
  return s.split('/').every((seg) => seg && seg !== '.' && seg !== '..');
}

// ------------------------------------------------------------------------------------------------
// The catalog
// ------------------------------------------------------------------------------------------------

/**
 * Validate + normalise a raw `index.json`. Anything unusable is dropped and reported as a warning
 * (never thrown): a single bad entry must not hide the rest of the catalog.
 * @param {unknown} json
 */
export function normalizeCatalog(json) {
  const warnings = [];
  const out = {
    version: Number(json?.version) || 1,
    catalogVersion: str(json?.catalogVersion, 40),
    updatedAt: str(json?.updatedAt, 40),
    base: str(json?.base, 40),
    baseCommit: str(json?.baseCommit, 40),
    mods: [],
    warnings,
  };
  const seen = new Set();
  const list = Array.isArray(json?.mods) ? json.mods : [];
  if (!isObj(json)) warnings.push('目录不是 JSON 对象');
  else if (!Array.isArray(json.mods)) warnings.push('目录缺少 mods 数组');
  for (const raw of list) {
    const id = str(raw?.id, 64);
    const kind = str(raw?.kind, 20) || 'patch';
    if (!MOD_ID_RE.test(id)) { warnings.push(`跳过：模组 id 不合法（"${id}"）`); continue; }
    if (seen.has(id.toLowerCase())) { warnings.push(`跳过：模组 id 重复（${id}）`); continue; }
    if (!MOD_KINDS[kind]) { warnings.push(`跳过：未知类型 "${kind}"（${id}）`); continue; }
    const patches = (Array.isArray(raw?.patches) ? raw.patches : []).map((p) => str(p, 200)).filter(Boolean);
    const files = (Array.isArray(raw?.files) ? raw.files : [])
      .map((f) => ({ path: str(f?.path, 200), url: str(f?.url, 200) }))
      .filter((f) => f.path && f.url);
    if (kind === 'patch' && !patches.length) { warnings.push(`跳过：${id} 没有 patches`); continue; }
    if (kind === 'overlay' && !files.length) { warnings.push(`跳过：${id} 没有 files`); continue; }
    seen.add(id.toLowerCase());
    out.mods.push({
      id,
      kind,
      name: str(raw?.name, 60) || id,
      subtitle: str(raw?.subtitle, 160),
      version: str(raw?.version, 40),
      base: str(raw?.base, 40) || out.base,
      baseCommit: str(raw?.baseCommit, 40) || out.baseCommit,
      order: Number.isFinite(Number(raw?.order)) ? Number(raw.order) : 1000,
      requires: (Array.isArray(raw?.requires) ? raw.requires : []).map((x) => str(x, 64)).filter(Boolean),
      conflicts: (Array.isArray(raw?.conflicts) ? raw.conflicts : []).map((x) => str(x, 64)).filter(Boolean),
      sizeBytes: Number(raw?.sizeBytes) || 0,
      license: str(raw?.license, 60),
      homepage: str(raw?.homepage, 200),
      notes: str(raw?.notes, 300),
      applicable: MOD_KINDS[kind].applicable,
      patches,
      files,
    });
  }
  out.mods.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return out;
}

/**
 * Where the catalog and its files live.
 * `modsRepoUrl` is normally a GitHub repository URL (read through raw.githubusercontent.com, with the
 * public mirrors as fallback). A URL that points straight at a `.json` file is used as-is — that is
 * how a self-hosted or mirrored catalog works — and then only that one origin is tried.
 * @param {object} cfg launcher config (`modsRepoUrl`)
 * @returns {{base:string, catalogUrl:string, mirrors:boolean}|null}
 */
export function catalogBaseOf(cfg) {
  const url = String(cfg?.modsRepoUrl || '').trim();
  if (!url) return null;
  if (/\.json(?:[?#].*)?$/i.test(url)) {
    const cut = url.lastIndexOf('/');
    if (cut < 0) return null;
    return { base: url.slice(0, cut + 1), catalogUrl: url, mirrors: false };
  }
  const base = rawBase(url, MODS_BRANCH);
  return base ? { base, catalogUrl: `${base}${MODS_INDEX}`, mirrors: true } : null;
}

/** The catalog cached on disk (so the UI renders offline); an empty catalog when none was fetched. */
export function readCatalog() {
  const c = readJson(CATALOG_FILE, null);
  if (!c) {
    return {
      version: 1, catalogVersion: '', updatedAt: '', base: '', mods: [], warnings: [],
      repoUrl: null, branch: MODS_BRANCH, fetchedAt: null, via: null, error: null,
    };
  }
  return {
    ...c,
    mods: Array.isArray(c.mods) ? c.mods : [],
    warnings: Array.isArray(c.warnings) ? c.warnings : [],
    error: c.error || null,
  };
}

/**
 * Fetch + cache the catalog from the relay repository, trying the public raw mirrors in turn.
 * @param {object} cfg launcher config (`modsRepoUrl`)
 * @param {{log?:(line:string,stream?:string)=>void}} [o]
 */
export async function fetchCatalog(cfg, { log = () => {} } = {}) {
  const where = catalogBaseOf(cfg);
  if (!where) throw new Error('模组仓库地址无效：请填 GitHub 仓库地址，或直接指向 index.json 的 URL。');
  const candidates = where.mirrors ? MIRRORS : [MIRRORS[0]];
  let lastErr = null;
  for (const m of candidates) {
    const url = m.prefix ? `${m.prefix}${where.catalogUrl}` : where.catalogUrl;
    try {
      const res = await fetchWithTimeout(url, { timeout: 15000, headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const catalog = normalizeCatalog(await res.json());
      // The relay repo versions its catalog (`catalogVersion` / `updatedAt`), so a refresh that moves
      // it forward can be reported as an update instead of silently swapping the list.
      const seen = readJson(SEEN_FILE, null);
      const moved = !!(seen?.catalogVersion && catalog.catalogVersion && seen.catalogVersion !== catalog.catalogVersion);
      const cache = {
        ...catalog, fetchedAt: nowIso(), via: m.id, error: null, fetchBase: where.base,
        repoUrl: toHttpsUrl(cfg.modsRepoUrl) || String(cfg.modsRepoUrl), branch: MODS_BRANCH,
        movedFrom: moved ? seen.catalogVersion : null,
      };
      writeJsonAtomic(CATALOG_FILE, cache);
      writeJsonAtomic(SEEN_FILE, { catalogVersion: catalog.catalogVersion, updatedAt: catalog.updatedAt, seenAt: nowIso() });
      for (const w of catalog.warnings) log(`⚠ ${w}`, 'stderr');
      const ver = catalog.catalogVersion ? `v${catalog.catalogVersion}` : '未标注版本';
      log(moved
        ? `✔ 模组目录已更新：v${seen.catalogVersion} → ${catalog.catalogVersion}（${catalog.mods.length} 个模组，基线 ${catalog.base || '未标注'}）`
        : `✔ 模组目录已就绪：${catalog.mods.length} 个（${ver}，基线 ${catalog.base || '未标注'}，来源 ${m.id}）`, 'stdout');
      return cache;
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }
  throw new Error(`无法获取模组目录：${lastErr || '未知错误'}`);
}

/**
 * Download one file of the catalog (a patch or an overlay file) through the mirrors.
 * @param {{repoUrl:string|null}} catalog
 */
async function downloadCatalogFile(catalog, rel, dest, { log = () => {} } = {}) {
  const base = catalog.fetchBase || catalogBaseOf({ modsRepoUrl: catalog.repoUrl })?.base;
  if (!base) throw new Error('模组仓库地址无效。');
  const mirrored = /^https:\/\/raw\.githubusercontent\.com\//.test(base);
  let lastErr = null;
  for (const m of (mirrored ? MIRRORS : [MIRRORS[0]])) {
    const url = m.prefix ? `${m.prefix}${base}${rel}` : `${base}${rel}`;
    try {
      await downloadFile(url, dest, { timeout: 60000 });
      return dest;
    } catch (e) {
      lastErr = e;
      try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    }
  }
  throw new Error(`下载 ${rel} 失败：${lastErr?.message || lastErr}`);
}

// ------------------------------------------------------------------------------------------------
// What is applied right now
// ------------------------------------------------------------------------------------------------

export const readLock = () => readJson(LOCK_FILE, null);
export const clearLock = () => { try { fs.rmSync(LOCK_FILE, { force: true }); } catch { /* best effort */ } };
const writeLock = (lock) => writeJsonAtomic(LOCK_FILE, lock);

const gitRun = (dir, args, timeout = 60000) => runCapture(gitCommand(), ['-C', dir, ...args], { timeout });

/**
 * `git status --porcelain` split by kind (untracked = files a mod added).
 * `-uall` matters: without it git collapses a wholly-untracked directory into one entry (`?? data/`),
 * and 「还原为原版」 would then try to delete a directory instead of the files the mod wrote.
 */
function gitStatus(dir) {
  const r = gitRun(dir, ['status', '--porcelain', '--untracked-files=all'], 30000);
  if (!r.ok) return { ok: false, untracked: [], changed: [] };
  const untracked = [];
  const changed = [];
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const rel = line.slice(3).trim().replace(/^"|"$/g, '');
    if (code === '??') untracked.push(rel);
    else changed.push(rel);
  }
  return { ok: true, untracked, changed };
}

/**
 * The mod state of the current install. Cheap by default (lock file only); `deep` also asks git
 * whether the working tree is actually dirty.
 * @param {object} cfg
 * @param {{deep?:boolean}} [o]
 */
export function modsStatus(cfg, { deep = false } = {}) {
  const dir = gameDir(cfg);
  const lock = readLock();
  const mods = Array.isArray(lock?.mods) ? lock.mods : [];
  const isRepo = isGitRepo(dir);
  const hasGit = !!gitCommand();
  const out = {
    dir,
    isRepo,
    hasGit,
    canApply: isRepo && hasGit,
    base: lock?.base || null,
    baseCommit: lock?.baseCommit || null,
    appliedAt: lock?.appliedAt || null,
    mods,
    applied: mods.length > 0,
    dirty: mods.length > 0,
    added: Array.isArray(lock?.added) ? lock.added.length : 0,
  };
  if (deep && out.canApply) {
    const st = gitStatus(dir);
    out.dirty = !st.ok || st.changed.length > 0 || st.untracked.length > 0;
    out.changed = st.changed.length;
    out.untracked = st.untracked.length;
  }
  return out;
}

/** `SP_MODS=<ids>` for the game server, so a mod can tell it is running modded. */
export function modsEnv() {
  const ids = (readLock()?.mods || []).map((m) => m.id).filter(Boolean);
  return ids.length ? { SP_MODS: ids.join(',') } : {};
}

/** Everything the UI needs: the cached catalog + which entries are enabled + the install state. */
export function modsState(cfg) {
  const catalog = readCatalog();
  const enabled = new Set((cfg?.enabledMods || []).map(String));
  return {
    // Show where the launcher is *configured* to look (the cache may still hold a previous catalog).
    repoUrl: String(cfg?.modsRepoUrl || '').trim() || null,
    branch: MODS_BRANCH,
    catalogVersion: catalog.catalogVersion || null,
    updatedAt: catalog.updatedAt || null,
    movedFrom: catalog.movedFrom || null,
    base: catalog.base || null,
    baseCommit: catalog.baseCommit || null,
    fetchedAt: catalog.fetchedAt || null,
    via: catalog.via || null,
    error: catalog.error || null,
    warnings: catalog.warnings || [],
    kinds: MOD_KINDS,
    mods: (catalog.mods || []).map((m) => ({ ...m, enabled: enabled.has(m.id) })),
    selected: [...enabled],
    status: modsStatus(cfg),
    preflight: checkBase(cfg),
  };
}

// ------------------------------------------------------------------------------------------------
// Applying / restoring
// ------------------------------------------------------------------------------------------------

/** Resolve the requested ids against the catalog: order, base, requires/conflicts. */
function selectMods(catalog, ids) {  const wanted = new Set((ids || []).map(String));
  const byId = new Map((catalog.mods || []).map((m) => [m.id, m]));
  const chosen = [];
  for (const id of wanted) {
    const mod = byId.get(id);
    if (!mod) throw new Error(`模组目录里没有 "${id}"，请先点「刷新目录」。`);
    if (!mod.applicable) throw new Error(`「${mod.name}」是整份 fork，不能作为补丁应用：${MOD_KINDS[mod.kind].summary}。`);
    chosen.push(mod);
  }
  if (!chosen.length) throw new Error('没有选择任何模组。');
  for (const mod of chosen) {
    // Compare the pinned commit when both sides carry one (it is exact); fall back to the ref label.
    const modBase = mod.baseCommit || mod.base;
    const catBase = catalog.baseCommit || catalog.base;
    if (modBase && catBase && modBase !== catBase) {
      throw new Error(`「${mod.name}」针对 ${mod.base || mod.baseCommit}，而目录基线是 ${catalog.base || catalog.baseCommit}，不能混用。`);
    }
  }
  const have = new Set(chosen.map((m) => m.id));
  for (const mod of chosen) {
    for (const r of mod.requires) {
      if (!have.has(r)) throw new Error(`「${mod.name}」依赖「${byId.get(r)?.name || r}」，请一并勾选。`);
    }
    for (const c of mod.conflicts) {
      if (have.has(c)) throw new Error(`「${mod.name}」与「${byId.get(c)?.name || c}」冲突，不能同时启用。`);
    }
  }
  return chosen.sort((a, b) => a.order - b.order);
}

/**
 * Put the tracked files back and clear the index. Used after a failed `--3way` apply, which leaves
 * conflict markers in the working tree and unmerged entries in the index; what the attempt *added*
 * (untracked) is removed by the caller, which knows the pre-apply baseline.
 */
function discardWorktree(dir) {
  gitRun(dir, ['reset', '-q'], 30000);
  gitRun(dir, ['checkout', '--', '.'], 60000);
}

// ------------------------------------------------------------------------------------------------
// Semantic merging of minified data files
// ------------------------------------------------------------------------------------------------

// `data/*.json` are minified onto a single line, so any change replaces that whole line: two mods that
// touch the same file conflict textually even when they change different records. For those files we
// can do better than failing — a three-way merge at the *JSON* level, key by key.
//
// Two properties make this safe rather than clever:
//   * the files round-trip exactly (`JSON.stringify(JSON.parse(text)) === text`), so a merged value is
//     written back in the project's own canonical minified form and nothing else in the file moves;
//   * the merge is conservative — it only combines changes that are provably independent and reports a
//     conflict for everything else, so it cannot quietly produce a file that means something else.

/** Absent key marker, so "removed on one side" is distinguishable from "never there". */
const MISSING = Symbol('missing');

/** Deep equality over parsed JSON. Objects compare by key set, not key order. */
function jsonEqual(a, b) {
  if (a === b) return true;
  if (a === MISSING || b === MISSING || a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (!Object.hasOwn(b, k) || !jsonEqual(a[k], b[k])) return false;
  return true;
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const atKey = (o, k) => (isPlainObject(o) && Object.hasOwn(o, k) ? o[k] : MISSING);

/**
 * Merge `theirs` into `ours` over their common `base`, recursively.
 * Exported for tests and tools; the mod manager is its only production caller.
 * @returns {{ok:true, value:unknown}|{ok:false, path:string}} the first disagreement's path when it fails
 */
export function mergeJson3(base, ours, theirs, at = '$') {
  // One side untouched, or both made the same change: nothing to reconcile.
  if (jsonEqual(ours, theirs)) return { ok: true, value: ours };
  if (jsonEqual(base, ours)) return { ok: true, value: theirs };
  if (jsonEqual(base, theirs)) return { ok: true, value: ours };
  // Both sides changed: only two plain objects can be combined key by key. Arrays are deliberately not
  // merged element-wise — reordering or inserting into one is exactly where a guess would be wrong.
  if (isPlainObject(base) && isPlainObject(ours) && isPlainObject(theirs)) {
    const out = {};
    const keys = [...Object.keys(ours)];
    for (const k of Object.keys(theirs)) if (!Object.hasOwn(ours, k)) keys.push(k);
    for (const k of keys) {
      const r = mergeJson3(atKey(base, k), atKey(ours, k), atKey(theirs, k), `${at}.${k}`);
      if (!r.ok) return r;
      if (r.value !== MISSING) out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false, path: at };
}

const stripNl = (s) => String(s).replace(/\n+$/, '');

/** Whether `text` is exactly what the project writes: minified, so a merged value can go back as-is. */
function isCanonicalJson(text) {
  try { return JSON.stringify(JSON.parse(text)) === stripNl(text); } catch { return false; }
}

/**
 * One entry per file of a unified diff: its path and the full text on each side. Only whole-file
 * hunks are usable (a minified data file is one line), which is exactly what this records.
 */
export function patchFileSections(patchText) {
  const sections = [];
  let cur = null;
  for (const raw of String(patchText).split('\n')) {
    const dm = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (dm) {
      cur = { rel: dm[2], oldLines: [], newLines: [], isNew: false, isDelete: false, inHunk: false };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('new file mode')) { cur.isNew = true; continue; }
    if (raw.startsWith('deleted file mode')) { cur.isDelete = true; continue; }
    if (raw.startsWith('--- ')) { if (raw === '--- /dev/null') cur.isNew = true; continue; }
    if (raw.startsWith('+++ ')) { if (raw === '+++ /dev/null') cur.isDelete = true; continue; }
    if (raw.startsWith('@@')) { cur.inHunk = true; continue; }
    if (/^(index |similarity |dissimilarity |rename |old mode |new mode |literal |GIT binary patch)/.test(raw)) continue;
    if (raw.startsWith('\\ No newline')) continue;
    if (!cur.inHunk) continue;
    if (raw.startsWith('-')) cur.oldLines.push(raw.slice(1));
    else if (raw.startsWith('+')) cur.newLines.push(raw.slice(1));
  }
  return sections;
}

/**
 * Resolve one file of a patch that did not apply, by merging its JSON at key level instead of by line.
 * `ours` is the worktree as it stands (the base plus whatever has been applied so far), the patch's own
 * "before" text is its pre-image, and its "after" text is what this mod wants.
 *
 * The patch's pre-image — not `HEAD` — is the right base: it is the file as this patch saw it, which for
 * the second and later patches of one mod is the state the first one produced.
 * @returns {boolean} whether this file was merged and written
 * @throws when both sides changed the same key (a real conflict the user must see)
 */
function semanticMergeJson(dir, rel, section, { log = () => {} } = {}) {
  if (section.isDelete || section.isNew || !/\.json$/i.test(rel)) return false;
  if (section.oldLines.length !== 1 || section.newLines.length !== 1) return false;

  // Only reason about single-line files the project writes in canonical minified form: then a merged
  // value goes back byte-identically and nothing else in the file moves.
  const baseText = stripNl(section.oldLines[0]);
  const nextText = stripNl(section.newLines[0]);
  if (!isCanonicalJson(baseText) || !isCanonicalJson(nextText)) return false;

  const full = path.join(dir, rel);
  const oursText = exists(full) ? stripNl(fs.readFileSync(full, 'utf8')) : baseText;
  let base, ours, theirs;
  try {
    base = JSON.parse(baseText);
    ours = oursText ? JSON.parse(oursText) : base;
    theirs = JSON.parse(nextText);
  } catch { return false; }

  const merged = mergeJson3(base, ours, theirs);
  if (!merged.ok) {
    throw new Error(
      `${rel} 的 ${merged.path} 处被两个模组同时修改（单行压缩数据无法按行合并，语义合并也判定为冲突）。\n`
      + '请在目录里声明这两个模组 conflicts，或只启用其中一个。',
    );
  }
  fs.writeFileSync(full, JSON.stringify(merged.value) + (section.newLines[0].endsWith('\n') || section.oldLines[0].endsWith('\n') ? '\n' : ''));
  log(`   语义合并：${rel} 按 JSON 键合并成功（双方改的是不同条目）。`, 'stdout');
  return true;
}

/**
 * Apply a patch that did not apply as a whole, file by file, so a minified data file can be merged at
 * the JSON level instead of failing the entire mod. The strict whole-patch attempt left nothing behind,
 * so the worktree is still "base + the mods so far" — which is `ours` for the merge.
 * @returns {{ok:true}|{ok:false, files:string[]}} the files that could not be resolved, if any
 */
function resolvePatchFileByFile(dir, patchFile, { log = () => {} } = {}) {
  const sections = patchFileSections(fs.readFileSync(patchFile, 'utf8'));
  if (!sections.length) return { ok: false, files: [] };
  const failed = [];
  // `git apply --3way` uses the index as its "ours" side, so it refuses with "does not match index"
  // while earlier mods' edits are unstaged. Stage the worktree for the pass and unstage it afterwards:
  // the changes must stay unstaged, because 「还原为原版」 and the lock file's list of added files both
  // read the index/worktree split.
  gitRun(dir, ['add', '-A'], 180000);
  try {
    for (const section of sections) {
      if (!section.rel || !isSafeRel(section.rel)) return { ok: false, files: [section.rel || '(?)'] };
      const one = (extra) => runCapture(
        gitCommand(), ['-C', dir, 'apply', '-p1', ...extra, '--whitespace=nowarn', `--include=${section.rel}`, patchFile], { timeout: 180000 },
      );
      if (one([]).ok) continue;
      if (semanticMergeJson(dir, section.rel, section, { log })) continue;
      if (one(['--3way']).ok) continue;
      failed.push(section.rel);
    }
  } finally {
    gitRun(dir, ['reset', '-q'], 60000);
  }
  if (failed.length) log(`   以下文件既不能直接应用、也不能合并（改动真正重叠）：${failed.slice(0, 6).join('、')}${failed.length > 6 ? ' …' : ''}`, 'meta');
  return failed.length ? { ok: false, files: failed } : { ok: true };
}

/** Apply one mod: a patch series, or a set of copied files. */
async function applyOne(cfg, catalog, mod, { log }) {
  const dir = gameDir(cfg);
  const work = path.join(DOWNLOAD_DIR, mod.id);
  fs.rmSync(work, { recursive: true, force: true });
  mkdirp(work);

  if (mod.kind === 'patch') {
    for (let i = 0; i < mod.patches.length; i++) {
      const rel = mod.patches[i];
      if (!isSafeRel(rel)) throw new Error(`补丁路径不合法：${rel}`);
      const file = path.join(work, `${String(i + 1).padStart(3, '0')}.patch`);
      await downloadCatalogFile(catalog, rel, file, { log });

      // Strict first: an exact patch applies cleanly and touches nothing else. When it does not, the
      // per-file pass resolves what it can — a minified data file through the JSON merge (which is what
      // lets two content mods stack), anything else through a three-way merge (context drift).
      const apply = (extra) => runCapture(gitCommand(), ['-C', dir, 'apply', '-p1', ...extra, '--whitespace=nowarn', file], { timeout: 180000 });
      if (!apply([]).ok) {
        log(`   补丁 ${rel} 未直接应用，逐文件尝试三方合并 / JSON 语义合并…`, 'meta');
        const res = resolvePatchFileByFile(dir, file, { log });
        if (!res.ok) {
          discardWorktree(dir);
          if (res.files.length) {
            throw new Error(
              `补丁未能应用（${rel}）：${res.files.length} 个文件与已应用的改动重叠，无法自动合并。\n`
              + `  · ${res.files.slice(0, 8).join('\n  · ')}\n`
              + '这通常说明它与另一个模组改了同一处代码。请在目录里声明这两个模组 conflicts，或只启用其中一个。',
            );
          }
          throw new Error(
            `补丁未能应用（${rel}），且无法自动合并。\n`
            + '这个模组多半与当前上游版本不匹配：点「还原为原版」后重试，或让中转仓库针对当前上游版本重新打包。',
          );
        }
      }
    }
    return;
  }

  // overlay
  for (const f of mod.files) {
    if (!isSafeRel(f.path) || !isSafeRel(f.url)) throw new Error(`覆盖清单里有不安全的路径：${f.path || f.url}`);
  }
  for (let i = 0; i < mod.files.length; i++) {
    const f = mod.files[i];
    const tmp = path.join(work, `f${String(i).padStart(3, '0')}`);
    await downloadCatalogFile(catalog, f.url, tmp, { log });
    const dest = path.join(dir, f.path);
    mkdirp(path.dirname(dest));
    fs.copyFileSync(tmp, dest);
  }
}

/**
 * Restore the install to the pinned base: undo every tracked change, then delete exactly the files
 * the mods added (from the lock) — a user's own untracked files elsewhere are left alone.
 * @param {object} cfg
 * @param {{log?:(line:string,stream?:string)=>void}} [o]
 */
export async function restoreGame(cfg, { log = () => {} } = {}) {
  const dir = gameDir(cfg);
  const lock = readLock();
  if (!isGitRepo(dir) || !gitCommand()) { clearLock(); return { ok: true, skipped: true }; }

  // Unstage first: `git checkout -- .` restores from the index, so a staged tree (an interrupted mod
  // apply) would otherwise come back as-is instead of returning to the base.
  gitRun(dir, ['reset', '-q'], 60000);
  const r = gitRun(dir, ['checkout', '--', '.'], 60000);
  if (!r.ok) throw new Error(`还原失败：${(r.out || '').split('\n')[0]}`);

  for (const rel of (lock?.added || [])) {
    if (!isSafeRel(rel)) continue;
    const full = path.join(dir, rel);
    try {
      if (fs.statSync(full).isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else fs.rmSync(full, { force: true });
    } catch { /* best effort */ }
    // Drop the directories the mod created, as long as they are empty now.
    let parent = path.dirname(full);
    while (parent.startsWith(dir) && parent !== dir) {
      try {
        if (fs.readdirSync(parent).length) break;
        fs.rmdirSync(parent);
      } catch { break; }
      parent = path.dirname(parent);
    }
  }
  clearLock();
  return { ok: true };
}

/** The install's pinned commit and version, for the preflight check. */
function installIdentity(dir) {
  const pkg = readJson(path.join(dir, 'package.json'), null);
  const head = isGitRepo(dir) && gitCommand() ? (gitRun(dir, ['rev-parse', 'HEAD'], 15000).out || '').trim() : '';
  const ref = isGitRepo(dir) && gitCommand() ? (gitRun(dir, ['describe', '--tags', '--abbrev=0'], 15000).out || '').trim() : '';
  return { version: pkg?.version ?? null, head: head || null, ref: ref || null };
}

/**
 * Check a selection against the catalog without touching the install, so the UI can refuse a bad
 * combination up front (an unknown id, a `profile` entry, a missing dependency, a declared conflict)
 * instead of surfacing it as a failed task.
 * @param {object} cfg
 * @param {string[]} ids
 * @returns {{ok:true}|{ok:false, error:string}}
 */
export function validateSelection(cfg, ids) {
  try {
    selectMods(readCatalog(), ids);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Whether the install is the exact base the catalog was packaged against. Patches are only guaranteed
 * against that one commit, so a mismatch is worth saying *before* the first `git apply` rather than
 * after it fails — or, worse, succeeds with the wrong meaning. When the catalog does not pin a commit
 * (an older/hand-written catalog) there is nothing to compare and the check passes.
 * @param {object} cfg
 * @returns {{ok:boolean, baseCommit:string|null, baseRef:string|null, installHead:string|null,
 *   installVersion:string|null, installRef:string|null}}
 */
export function checkBase(cfg) {
  const catalog = readCatalog();
  const identity = installIdentity(gameDir(cfg));
  const baseCommit = catalog.baseCommit || null;
  return {
    ok: !baseCommit || !identity.head || identity.head === baseCommit,
    baseCommit,
    baseRef: catalog.base || null,
    installHead: identity.head,
    installVersion: identity.version,
    installRef: identity.ref,
  };
}

/**
 * Apply the selected mods on top of a freshly restored install.
 * @param {object} cfg launcher config
 * @param {string[]} ids the mod ids to enable
 * @param {{log?:(line:string,stream?:string)=>void, allowBaseMismatch?:boolean}} [o]
 *   `allowBaseMismatch` proceeds even though the install is not at the catalog's pinned base (the UI
 *   asks the user first); without it a mismatch is refused with an explanation.
 */
export async function applyMods(cfg, ids, { log = () => {}, allowBaseMismatch = false } = {}) {
  const dir = gameDir(cfg);
  if (!exists(path.join(dir, 'package.json'))) throw new Error('尚未部署游戏，请先「一键部署」。');
  if (!gitCommand()) throw new Error('应用模组需要 git（以补丁方式安装）。请安装 git 后重试。');
  if (!isGitRepo(dir)) throw new Error('当前安装是压缩包解压的，不是 git 检出，无法应用补丁模组。请用 git 方式重新部署后再试。');

  const catalog = readCatalog();
  const mods = selectMods(catalog, ids);

  const pre = checkBase(cfg);
  if (!pre.ok) {
    const at = pre.installRef ? `${pre.installRef}（${String(pre.installHead).slice(0, 8)}）` : String(pre.installHead).slice(0, 8);
    const want = pre.baseRef ? `${pre.baseRef}（${String(pre.baseCommit).slice(0, 8)}）` : String(pre.baseCommit).slice(0, 8);
    const msg = `安装目录是 ${at}，而模组目录针对 ${want} —— 补丁只保证在前者等于后者时可用。`
      + '\n请先把游戏更新/切换到该版本，或等中转仓库针对当前版本重新打包。';
    if (!allowBaseMismatch) throw new Error(msg + '\n（确实想试试的话，界面上会再问一次。）');
    log(`⚠ ${msg}\n  已按你的选择继续尝试。`, 'stderr');
  }

  // Patches only apply to the base, so always start from a clean tree.
  log('▶ 还原到干净的上游版本…', 'meta');
  const before = new Set(gitStatus(dir).untracked);
  await restoreGame(cfg, { log });
  const baseline = new Set(gitStatus(dir).untracked);

  try {
    for (const mod of mods) {
      log(`▶ 应用模组：${mod.name}（${MOD_KINDS[mod.kind].label}${mod.version ? ` v${mod.version}` : ''}）`, 'meta');
      await applyOne(cfg, catalog, mod, { log });
    }
  } catch (e) {
    // Leave the install as clean as it was, so a failed attempt never looks like a half-applied mod.
    discardWorktree(dir);
    for (const rel of gitStatus(dir).untracked) {
      if (baseline.has(rel) || before.has(rel) || !isSafeRel(rel)) continue;
      try { fs.rmSync(path.join(dir, rel), { force: true }); } catch { /* best effort */ }
    }
    throw e;
  }

  const after = gitStatus(dir).untracked.filter((p) => !baseline.has(p) && !before.has(p));
  const lock = {
    base: catalog.base || null,
    baseCommit: catalog.baseCommit || null,
    appliedAt: nowIso(),
    repoUrl: catalog.repoUrl || null,
    mods: mods.map((m) => ({ id: m.id, name: m.name, kind: m.kind, version: m.version || null })),
    added: after,
  };
  writeLock(lock);
  log(`✔ 已应用 ${mods.length} 个模组；安装目录现为「原版 + 模组」状态`, 'stdout');
  return { ok: true, applied: lock.mods, added: after.length, baseMismatch: !pre.ok };
}
