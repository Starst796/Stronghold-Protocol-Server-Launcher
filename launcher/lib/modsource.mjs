// launcher/lib/modsource.mjs — read the community mod repository and install from it.
//
// The mods live in `XiaMo233M/Stronghold-Protocol-Forge-Mods`: `mods/index.json` is its single source of
// truth (per-file sha256, size, category, and what the engine itself did when it loaded the pack), and
// the payload is one byte-exact `mod.zip` per entry. Nothing here is hosted by us.
//
// Two install routes exist because a version may be one of two engines:
//
//   workshop  the Forge engine's native content packs — `tools/workshop-pack.mjs import`, into
//             `workshop/<id>/`. All of the repository installs this way.
//   plugin    the plugin system that upstream 0.3.0 and Forge both ship — a workshop pack is converted
//             with `tools/plugin.mjs import-forge`, into `plugins/`. Only part of the repository can be
//             converted, so the report the CLI prints is passed straight through to the user.
//
// Neither route runs any of the pack's code during install: the engine's own importer reads bytes only.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, assetRouteOf } from './config.mjs';
import { exists, readJson, writeJsonAtomic, mkdirp, runCapture, formatBytes, nowIso } from './util.mjs';

/** The community mod repository. Its own `mods/index.json` is the manifest we read. */
export const MODS_SOURCE = Object.freeze({
  slug: 'XiaMo233M/Stronghold-Protocol-Forge-Mods',
  branch: 'main',
  label: 'Forge 工坊包源',
  indexPath: 'mods/index.json',
});

/** raw.githubusercontent needs a prefix in China (`''` = direct). */
const RAW_MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/'];

/**
 * The prefixes to try, in order. The user's chosen 「下载源」 comes first when it is an accelerator, so
 * the mod source behaves like every other download in the launcher instead of always paying for a slow
 * or blocked direct connection first.
 * @param {object} [cfg] launcher config
 */
function mirrorsFor(cfg) {
  const proxy = assetRouteOf(cfg || {})?.proxy;
  const out = [];
  if (proxy) out.push(proxy);
  for (const m of RAW_MIRRORS) if (!out.includes(m)) out.push(m);
  return out;
}

const CACHE_DIR = path.join(ROOT, '.cache');
const INDEX_CACHE = path.join(CACHE_DIR, 'modsource-index.json');
const STATE_FILE = path.join(CACHE_DIR, 'modsource-state.json');
const INDEX_CACHE_MS = 30 * 60 * 1000;

const rawUrl = (rel) => `https://raw.githubusercontent.com/${MODS_SOURCE.slug}/${MODS_SOURCE.branch}/${rel}`;

/** Fetch a small text resource, trying the mirrors in order. */
async function fetchText(url, { timeout = 30000, cfg } = {}) {
  let last = null;
  const mirrored = /^https:\/\/raw\.githubusercontent\.com\//.test(url);
  for (const prefix of (mirrored ? mirrorsFor(cfg) : [''])) {
    try {
      const res = await fetch(prefix ? `${prefix}${url}` : url, { redirect: 'follow', signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) { last = e; }
  }
  throw new Error(`下载失败：${last?.message || last}`);
}

/** The first byte has to arrive within this; a quieter-than-this transfer is considered dead. */
const IDLE_MS = 30000;
const HEADERS_MS = 20000;

/**
 * Download to a file through the mirrors, reporting progress.
 *
 * A mirror can answer and then go silent — the direct route to `raw.githubusercontent.com` does that on
 * some networks — so a stalled transfer is aborted after `IDLE_MS` and the next mirror is tried. A
 * single overall deadline would either cut off a legitimately slow big download or let a dead one run
 * for minutes.
 */
async function fetchToFile(url, dest, { onProgress, cfg } = {}) {
  mkdirp(path.dirname(dest));
  let last = null;
  const mirrored = /^https:\/\/raw\.githubusercontent\.com\//.test(url);
  for (const prefix of (mirrored ? mirrorsFor(cfg) : [''])) {
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(), HEADERS_MS);
    const bump = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), IDLE_MS); };
    try {
      const res = await fetch(prefix ? `${prefix}${url}` : url, { redirect: 'follow', signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      bump();
      const total = Number(res.headers.get('content-length')) || 0;
      let loaded = 0;
      const { Readable } = await import('node:stream');
      const { pipeline } = await import('node:stream/promises');
      const stream = Readable.fromWeb(res.body);
      stream.on('data', (c) => { loaded += c.length; bump(); onProgress?.(loaded, total); });
      await pipeline(stream, fs.createWriteStream(dest));
      return { bytes: loaded, total };
    } catch (e) {
      last = e;
      try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`下载失败：${last?.message || last}`);
}

export const sha256File = (p) => {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
};

/**
 * The repository's manifest, cached for half an hour.
 * @param {{force?:boolean, log?:(line:string,stream?:string)=>void}} [o]
 */
export async function fetchModIndex({ force = false, log = () => {}, cfg } = {}) {
  const cache = readJson(INDEX_CACHE, null);
  if (!force && cache?.at && Date.now() - cache.at < INDEX_CACHE_MS) return { ...cache, cached: true };
  log('▶ 读取 mod 源目录…', 'meta');
  const text = await fetchText(rawUrl(MODS_SOURCE.indexPath), { cfg });
  const json = JSON.parse(text);
  if (!json || !Array.isArray(json.mods)) throw new Error('mod 源目录格式不对（没有 mods 数组）。');
  const next = { at: Date.now(), fetchedAt: nowIso(), index: json, error: null };
  mkdirp(CACHE_DIR);
  writeJsonAtomic(INDEX_CACHE, next);
  return { ...next, cached: false };
}

/**
 * Normalise the manifest into rows for the UI. Only `id`/`name`/`version`/`sha256`/`path` are required;
 * everything else is optional and shown when present.
 *
 * The repository warns that a directory listing is not the manifest (`mods/mod-xie/2.0.0/` is on disk
 * but deliberately excluded — one version per pack id), so the index is the only thing read.
 */
export function modRows(index) {
  return (index?.mods || []).map((m) => {
    const load = m.engineLoad || {};
    return {
      id: String(m.id || ''),
      name: String(m.name || m.id || ''),
      version: String(m.version || ''),
      sha256: String(m.sha256 || ''),
      size: Number(m.sizeBytes) || 0,
      files: Number(m.fileCount) || 0,
      category: String(m.category || ''),
      layer: String(load.layer || ''),
      combat: load.combat === true,
      loadErrors: Array.isArray(load.errors) ? load.errors : [],
      loaded: Array.isArray(load.packsLoaded) ? load.packsLoaded : [],
      assetFree: m.assets?.assetFree !== false,
      assets: m.assets || null,
      notes: Array.isArray(m.notes) ? m.notes : [],
      path: String(m.path || ''),
      url: m.path ? rawUrl(m.path) : '',
    };
  }).filter((m) => m.id && m.url);
}

/**
 * Which install route this version supports. The Forge engine can do both, and its native workshop
 * packs cover the whole repository, so that route wins when present.
 * @param {string} dir an installed version's directory
 */
export function detectModSupport(dir) {
  if (!dir || !exists(path.join(dir, 'package.json'))) {
    return { mode: 'none', reason: '版本目录不完整（缺少 package.json）。' };
  }
  const pkg = readJson(path.join(dir, 'package.json'), {}) || {};
  const engine = String(pkg.version || '');
  const hasWorkshop = exists(path.join(dir, 'tools', 'workshop-pack.mjs'));
  const hasPlugin = exists(path.join(dir, 'tools', 'plugin.mjs')) && exists(path.join(dir, 'server', 'plugins'));
  if (hasWorkshop && hasPlugin) {
    return { mode: 'workshop', engine, both: true, reason: '这是 Forge 引擎：工坊包原生安装，全部条目可用。' };
  }
  if (hasWorkshop) return { mode: 'workshop', engine, reason: '这个引擎支持工坊包。' };
  if (hasPlugin) {
    return {
      mode: 'plugin', engine,
      reason: `这个引擎（${engine}）支持插件，但不支持工坊包：工坊包会经引擎自带的 import-forge 转换成插件，只有部分条目能装。`,
    };
  }
  return {
    mode: 'none', engine,
    reason: `这个引擎（${engine || '未知版本'}）既没有工坊支持也没有插件系统（插件需要 0.3.0 及以上）。`,
  };
}

// ------------------------------------------------------------------------------------------------
// What we installed (our own bookkeeping, kept outside the version so it never shows up in git status)
// ------------------------------------------------------------------------------------------------

const readState = () => readJson(STATE_FILE, {}) || {};
const writeState = (s) => { mkdirp(CACHE_DIR); writeJsonAtomic(STATE_FILE, s); };

/** The mods this launcher installed into one version: `{ [modId]: {...} }`. */
export function installedMods(installId) {
  return readState()[installId]?.mods || {};
}

function noteInstalled(installId, modId, rec) {
  const all = readState();
  const entry = all[installId] || { mods: {} };
  entry.mods = { ...(entry.mods || {}), [modId]: rec };
  writeJsonAtomic(STATE_FILE, { ...all, [installId]: entry });
}

function noteRemoved(installId, modId) {
  const all = readState();
  const entry = all[installId];
  if (!entry?.mods?.[modId]) return;
  const mods = { ...entry.mods };
  delete mods[modId];
  writeJsonAtomic(STATE_FILE, { ...all, [installId]: { ...entry, mods } });
}

// ------------------------------------------------------------------------------------------------
// Installing
// ------------------------------------------------------------------------------------------------

/** Run one of the game's own tools with our node, from inside the version. */
function runTool(dir, args, { timeout = 300000 } = {}) {
  const r = runCapture(process.execPath, args, {
    cwd: dir,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: r.ok, out: String(r.out || '').trim() };
}

/**
 * Download one mod, verify it against the manifest, then hand it to the engine's own installer.
 * @param {object} cfg launcher config
 * @param {object} entry the version to install into
 * @param {object} mod a row from `modRows`
 * @param {{log?:Function, onProgress?:Function}} [o]
 * @returns {Promise<{ok:boolean, mode:string, id:string, products?:string[], report?:string, error?:string}>}
 */
export async function installMod(cfg, entry, mod, { log = () => {}, onProgress } = {}) {
  const support = detectModSupport(entry.dir);
  if (support.mode === 'none') throw new Error(support.reason);

  const zipPath = path.join(CACHE_DIR, 'mods', `${mod.id}-${mod.version}.zip`.replace(/[^\w.\-]+/g, '_'));
  if (!exists(zipPath) || (mod.size > 0 && fs.statSync(zipPath).size !== mod.size)) {
    log(`▶ 下载 ${mod.name} ${mod.version}（${formatBytes(mod.size)}）`, 'meta');
    await fetchToFile(mod.url, zipPath, { onProgress, cfg });
  } else {
    log(`✔ 已有缓存：${mod.id} ${mod.version}`, 'stdout');
  }

  if (mod.sha256) {
    const got = sha256File(zipPath);
    if (got !== mod.sha256) {
      fs.rmSync(zipPath, { force: true });
      throw new Error(`校验失败：${mod.id} 的 sha256 与目录不一致（下载到的字节不是源里那一份），已丢弃。`);
    }
    log('✔ sha256 与目录一致', 'stdout');
  } else {
    log('⚠ 目录里没有 sha256，跳过校验。', 'meta');
  }

  if (support.mode === 'workshop') {
    const r = runTool(entry.dir, [path.join('tools', 'workshop-pack.mjs'), 'import', zipPath]);
    if (!r.ok) throw new Error(`引擎拒绝了这个包：\n${r.out.slice(0, 600)}`);
    log(r.out || `已安装 ${mod.id}`, 'stdout');
    const rec = { id: mod.id, name: mod.name, version: mod.version, mode: 'workshop', sha256: mod.sha256, at: nowIso() };
    noteInstalled(entry.id, mod.id, rec);
    return { ok: true, mode: 'workshop', id: mod.id, products: [mod.id] };
  }

  const r = runTool(entry.dir, [path.join('tools', 'plugin.mjs'), 'import-forge', zipPath, '--json']);
  let report = null;
  try { report = JSON.parse(r.out.split('\n').find((l) => l.trim().startsWith('{')) || r.out); } catch { /* not JSON */ }
  const products = (report?.products || []).map((p) => p.id).filter(Boolean);
  if (!report) throw new Error(`转换失败（没有可解析的报告）：\n${r.out.slice(0, 600)}`);
  if (!report.ok) {
    const why = (report.issues || []).map((i) => `${i.detail || i.code}`).join('\n') || '未知原因';
    throw new Error(
      `这个工坊包无法转换成插件：\n${why}\n`
      + '（引擎的转换器只覆盖部分工坊包。工坊包在 Forge 版本上是原生安装的，换那个版本可用全部条目。）',
    );
  }
  if (!products.length) {
    throw new Error(
      `这个工坊包没有可导入的内容：${(report.skipped || []).map((s) => s.path).slice(0, 6).join('、') || '全部条目都被跳过'}`
      + '\n（例如它只声明了引擎写死的行为开关，或只用界面主题。若要用它，请在 Forge 版本上安装。）',
    );
  }
  const skipped = (report.skipped || []).map((s) => s.path);
  log(`✔ 已转换成插件：${products.join('、')}${skipped.length ? `（跳过 ${skipped.length} 项：${skipped.slice(0, 4).join('、')}…）` : ''}`, 'stdout');
  noteInstalled(entry.id, mod.id, { id: mod.id, name: mod.name, version: mod.version, mode: 'plugin', sha256: mod.sha256, products, at: nowIso() });
  return { ok: true, mode: 'plugin', id: mod.id, products, skipped };
}

/**
 * Remove a mod this launcher installed. Uninstalling never just deletes: the workshop route hands the
 * folder to the engine's own registry (which moves it into `.mod-backups/`), and the plugin route only
 * removes the plugin folders the import reported.
 */
export async function removeMod(cfg, entry, modId, { log = () => {} } = {}) {
  const all = installedMods(entry.id);
  const rec = all[modId];
  if (!rec) throw new Error('这个 mod 不是启动器装的，无法在这里卸载。');

  if (rec.mode === 'workshop') {
    const r = runTool(entry.dir, [path.join('tools', 'workshop-pack.mjs'), 'uninstall', modId]);
    if (!r.ok) throw new Error(`引擎拒绝卸载：\n${r.out.slice(0, 400)}`);
    log(r.out || `已卸载 ${modId}`, 'stdout');
  } else {
    const dirs = rec.products?.length ? rec.products : [modId];
    for (const id of dirs) {
      const p = path.join(entry.dir, 'plugins', id);
      if (!exists(p)) continue;
      fs.rmSync(p, { recursive: true, force: true });
      log(`已删除 plugins/${id}`, 'stdout');
    }
  }
  noteRemoved(entry.id, modId);
  return { ok: true, mode: rec.mode };
}

/**
 * Turn an installed workshop pack on or off. The engine keeps this in its own registry, so the switch
 * survives updates; plugin activation is per room or per player and has no equivalent here.
 */
export async function setModEnabled(cfg, entry, modId, enabled, { log = () => {} } = {}) {
  const rec = installedMods(entry.id)[modId];
  if (!rec) throw new Error('这个 mod 不是启动器装的。');
  if (rec.mode !== 'workshop') {
    throw new Error('插件没有全局启停：它由房间（房主开启）或个人（设置里开启）选择，可在服务器上改 plugins/config.json 的策略。');
  }
  const r = runTool(entry.dir, [path.join('tools', 'workshop-pack.mjs'), enabled ? 'enable' : 'disable', modId]);
  if (!r.ok) throw new Error(`引擎拒绝改状态：\n${r.out.slice(0, 400)}`);
  log(r.out || `已${enabled ? '启用' : '禁用'} ${modId}`, 'stdout');
  noteInstalled(entry.id, modId, { ...rec, enabled, at: rec.at });
  return { ok: true, enabled };
}

/** The engine's own view of what is installed, for the UI to reconcile against. */
export function engineModList(entry) {
  const support = detectModSupport(entry.dir);
  if (support.mode === 'none') return { mode: 'none', rows: [] };
  const tool = support.mode === 'workshop' ? 'workshop-pack.mjs' : 'plugin.mjs';
  const r = runTool(entry.dir, [path.join('tools', tool), 'list'], { timeout: 60000 });
  return { mode: support.mode, output: r.out.split('\n').slice(0, 60) };
}
