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
      const ver = catalog.catalogVersion ? ` v${catalog.catalogVersion}` : '';
      log(moved
        ? `✔ 模组目录已更新：v${seen.catalogVersion} → ${catalog.catalogVersion}（${catalog.mods.length} 个模组，基线 ${catalog.base || '未标注'}）`
        : `✔ 模组目录已就绪：${catalog.mods.length} 个（${ver || '未标注版本'}，基线 ${catalog.base || '未标注'}，来源 ${m.id}）`, 'stdout');
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
    fetchedAt: catalog.fetchedAt || null,
    via: catalog.via || null,
    error: catalog.error || null,
    warnings: catalog.warnings || [],
    kinds: MOD_KINDS,
    mods: (catalog.mods || []).map((m) => ({ ...m, enabled: enabled.has(m.id) })),
    selected: [...enabled],
    status: modsStatus(cfg),
  };
}

// ------------------------------------------------------------------------------------------------
// Applying / restoring
// ------------------------------------------------------------------------------------------------

/** Resolve the requested ids against the catalog: order, base, requires/conflicts. */
function selectMods(catalog, ids) {
  const wanted = new Set((ids || []).map(String));
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
    if (mod.base && catalog.base && mod.base !== catalog.base) {
      throw new Error(`「${mod.name}」针对 ${mod.base}，而目录基线是 ${catalog.base}，不能混用。`);
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
      const r = runCapture(gitCommand(), ['-C', dir, 'apply', '-p1', '--whitespace=nowarn', file], { timeout: 180000 });
      if (!r.ok) {
        const detail = (r.out || '').split('\n').slice(0, 8).join('\n');
        throw new Error(`补丁未能应用（${rel}）：\n${detail}\n多半是这个模组与当前上游版本不匹配 —— 点「还原为原版」后重试，或让中转仓库重新打包该模组。`);
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

/**
 * Apply the selected mods on top of a freshly restored install.
 * @param {object} cfg launcher config
 * @param {string[]} ids the mod ids to enable
 * @param {{log?:(line:string,stream?:string)=>void}} [o]
 */
export async function applyMods(cfg, ids, { log = () => {} } = {}) {
  const dir = gameDir(cfg);
  if (!exists(path.join(dir, 'package.json'))) throw new Error('尚未部署游戏，请先「一键部署」。');
  if (!gitCommand()) throw new Error('应用模组需要 git（以补丁方式安装）。请安装 git 后重试。');
  if (!isGitRepo(dir)) throw new Error('当前安装是压缩包解压的，不是 git 检出，无法应用补丁模组。请用 git 方式重新部署后再试。');

  const catalog = readCatalog();
  const mods = selectMods(catalog, ids);

  // Patches only apply to the base, so always start from a clean tree.
  log('▶ 还原到干净的上游版本…', 'meta');
  const before = new Set(gitStatus(dir).untracked);
  await restoreGame(cfg, { log });
  const baseline = new Set(gitStatus(dir).untracked);

  for (const mod of mods) {
    log(`▶ 应用模组：${mod.name}（${MOD_KINDS[mod.kind].label}${mod.version ? ` v${mod.version}` : ''}）`, 'meta');
    await applyOne(cfg, catalog, mod, { log });
  }

  const after = gitStatus(dir).untracked.filter((p) => !baseline.has(p) && !before.has(p));
  const lock = {
    base: catalog.base || null,
    appliedAt: nowIso(),
    repoUrl: catalog.repoUrl || null,
    mods: mods.map((m) => ({ id: m.id, name: m.name, kind: m.kind, version: m.version || null })),
    added: after,
  };
  writeLock(lock);
  log(`✔ 已应用 ${mods.length} 个模组；安装目录现为「原版 + 模组」状态`, 'stdout');
  return { ok: true, applied: lock.mods, added: after.length };
}
