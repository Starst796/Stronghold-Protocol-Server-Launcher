// launcher/lib/pluginsource.mjs — the plugin catalogue that ships with the launcher, and the ways in.
//
// The engine's plugin system (upstream 0.3.0 and up) has a catalogue format and a hash-pinned
// installer, but nobody publishes plugin *packages*: the authors publish folders in their own
// repositories, and the project itself hosts no zips. So this module keeps two things instead:
//
//   * `launcher/data/plugin-catalog.json` — a small, git-managed list of what is known to exist, what
//     it can do, which engine it targets, and where it comes from. It is a document, not a store.
//   * the ways bytes actually arrive — from the author's own repository (`source`), from a zip the
//     user already has, or from an address the user pastes. We host none of them.
//
// Nothing here runs a plugin's code. `pack` writes a lock and checks the folder, `install` only
// unpacks a zip after the engine's own checks pass, and both are the engine's own tools.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT } from './config.mjs';
import { exists, readJson, writeJsonAtomic, mkdirp, runCapture, formatBytes, compareVersions, nowIso } from './util.mjs';
import { downloadFile } from './repo.mjs';
import { extractTar } from './repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The catalogue is part of the launcher's own tree, so it travels with it and is reviewable in git. */
export const CATALOG_FILE = path.join(HERE, '..', 'data', 'plugin-catalog.json');

const CACHE_DIR = path.join(ROOT, '.cache');
const STATE_FILE = path.join(CACHE_DIR, 'pluginsource-state.json');
const PLUGIN_CACHE = path.join(CACHE_DIR, 'plugins');

/** Tarball downloads: pkg hosts first for the same reason every other download does. */
const TAR_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/', ''];
/** Prefixes for a plain github.com URL (release assets). */
const URL_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/', ''];

/** The shipped catalogue, or an empty one when the file is missing or unreadable. */
export function readCatalog() {
  const doc = readJson(CATALOG_FILE, null);
  if (!doc || !Array.isArray(doc.plugins)) return { version: 1, updatedAt: '', note: '', plugins: [], error: '插件目录文件读不到。' };
  return doc;
}

/** The engine version of an installed version — the thing an `app` range is compared against. */
export function engineApp(dir) {
  const pkg = readJson(path.join(dir, 'package.json'), null);
  return pkg?.version ? String(pkg.version) : '';
}

/**
 * Does `version` satisfy a range like `>=0.3.0 <0.4.0`? Only the operators the manifests actually use
 * (`>=`, `>`, `<=`, `<`, `=`), because pretending to implement npm ranges would be worse than saying
 * "unknown" for anything else.
 * @returns {'ok'|'bad'|'unknown'}
 */
export function satisfiesApp(range, version) {
  const r = String(range || '').trim();
  if (!r || !version) return 'unknown';
  const tokens = r.split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    const m = /^(>=|<=|>|<|=)?\s*v?(\d[\w.\-+]*)$/.exec(t);
    if (!m) return 'unknown';
    const op = m[1] || '=';
    const want = m[2];
    const c = compareVersions(version, want);
    const ok = op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
    if (!ok) return 'bad';
  }
  return 'ok';
}

/** One catalogue row, with the verdicts the UI needs. */
export function describeItem(item, { engine = '', installed = {} } = {}) {
  const have = installed[item.id];
  return {
    id: String(item.id || ''),
    name: String(item.name || item.id || ''),
    englishName: String(item.englishName || ''),
    class: String(item.class || ''),
    version: String(item.version || ''),
    app: String(item.app || ''),
    scope: Array.isArray(item.scope) ? item.scope : [].concat(item.scope || []),
    permissions: Array.isArray(item.permissions) ? item.permissions : [],
    authors: Array.isArray(item.authors) ? item.authors : [].concat(item.authors || []),
    license: String(item.license || ''),
    homepage: String(item.homepage || ''),
    description: String(item.description || ''),
    source: item.source ? { repo: String(item.source.repo || ''), branch: String(item.source.branch || 'main'), path: String(item.source.path || '') } : null,
    // The author's own published zip, when there is one: smaller than the repository tarball, and
    // pinned to a hash we verified against the bytes ourselves.
    dist: item.dist ? {
      url: String(item.dist.url || ''), sha256: String(item.dist.sha256 || ''), bytes: Number(item.dist.bytes) || 0,
      tag: String(item.dist.tag || ''), declared: item.dist.sha256DeclaredByAuthor === true,
    } : null,
    authorNote: String(item.authorNote || ''),
    manual: item.install === 'manual',
    manualReason: String(item.manualReason || ''),
    appVerdict: satisfiesApp(item.app, engine),
    installed: have || null,
  };
}

// ------------------------------------------------------------------------------------------------
// Bookkeeping (our own, kept out of the version so it never shows up in git status)
// ------------------------------------------------------------------------------------------------

const readState = () => readJson(STATE_FILE, {}) || {};
const writeState = (s) => { mkdirp(CACHE_DIR); writeJsonAtomic(STATE_FILE, s); };

/** The whole state file, for the caller that reconciles it against the disk. */
export const pluginStateAll = readState;
export const writePluginState = writeState;

/** Plugins this launcher installed into one version: `{ [id]: {...} }`. */
export function installedPlugins(installId) {
  return readState()[installId]?.items || {};
}

const noteInstalled = (installId, id, rec) => {
  const all = readState();
  const e = all[installId] || { items: {} };
  writeJsonAtomic(STATE_FILE, { ...all, [installId]: { ...e, items: { ...(e.items || {}), [id]: rec } } });
};

const noteRemoved = (installId, id) => {
  const all = readState();
  const e = all[installId];
  if (!e?.items?.[id]) return;
  const items = { ...e.items };
  delete items[id];
  writeJsonAtomic(STATE_FILE, { ...all, [installId]: { ...e, items } });
};

// ------------------------------------------------------------------------------------------------
// Talking to the engine's own tool
// ------------------------------------------------------------------------------------------------

const pluginTool = (dir) => path.join('tools', 'plugin.mjs');

/** Is the plugin system present in this version? */
export function pluginSupport(dir) {
  if (!exists(path.join(dir, 'package.json'))) return { ok: false, reason: '版本目录不完整。' };
  if (!exists(path.join(dir, pluginTool(dir)))) {
    return { ok: false, reason: '这个引擎没有插件系统（插件需要 0.3.0 及以上）。' };
  }
  return { ok: true, engine: engineApp(dir) };
}

function runTool(dir, args, { timeout = 300000 } = {}) {
  const r = runCapture(process.execPath, args, { cwd: dir, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.ok, out: String(r.out || '').trim() };
}

/** The engine's own view of what is installed, as JSON. */
export function enginePluginList(dir) {
  const r = runTool(dir, [pluginTool(dir), 'list', '--json'], { timeout: 60000 });
  if (!r.ok) return { ok: false, error: r.out.slice(0, 400), plugins: [] };
  try {
    const json = JSON.parse(r.out.slice(r.out.indexOf('{')));
    // Shape: { index: { app, api, content, plugins: [...] }, skipped: [...], warnings: [...] }
    const idx = json.index || {};
    return {
      ok: true,
      app: String(idx.app || ''),
      plugins: Array.isArray(idx.plugins) ? idx.plugins.map((p) => ({
        id: String(p.id || ''), class: String(p.class || ''), status: String(p.status || ''),
        name: typeof p.name === 'object' ? (p.name?.zh || p.name?.en || '') : String(p.name || ''),
        version: String(p.version || ''), app: String(p.app || ''),
        compatible: p.compatible !== false, source: String(p.source || ''), manifest: p.manifest ?? null,
      })) : [],
      skipped: Array.isArray(json.skipped) ? json.skipped : [],
      warnings: Array.isArray(json.warnings) ? json.warnings : [],
    };
  } catch {
    return { ok: false, error: '无法解析引擎输出。', raw: r.out.slice(0, 600), plugins: [] };
  }
}

// ------------------------------------------------------------------------------------------------
// The three ways in
// ------------------------------------------------------------------------------------------------

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Install a plugin folder from its author's repository.
 *
 * There is no zip to download — the authors publish folders — so the repository tarball is fetched,
 * the named subdirectory is copied into `plugins/<id>/`, and then the engine's `pack` writes the lock
 * (per-file SHA-256, Spine clip data) and re-checks the folder. Nothing is redistributed by us: the
 * bytes come from the author, and the verification is the engine's own.
 */
export async function installFromSource(entry, item, { log = () => {}, onProgress } = {}) {
  const support = pluginSupport(entry.dir);
  if (!support.ok) throw new Error(support.reason);
  const src = item.source;
  if (!src?.repo || !src.path) throw new Error('这条目录没有记录来源仓库，无法自动取回。');

  mkdirp(PLUGIN_CACHE);
  const tarPath = path.join(PLUGIN_CACHE, `${item.id}-${src.branch}.tar.gz`.replace(/[^\w.\-]+/g, '_'));
  const url = `https://codeload.github.com/${src.repo}/tar.gz/refs/heads/${src.branch}`;
  const needs = !exists(tarPath) || (Date.now() - fs.statSync(tarPath).mtimeMs > 6 * 3600 * 1000);
  if (needs) {
    log(`▶ 取回 ${src.repo}（${src.branch}）的源码包…`, 'meta');
    let last = null;
    for (const prefix of TAR_MIRRORS) {
      try {
        await downloadFile(prefix ? `${prefix}${url}` : url, tarPath, { timeout: 30000, idle: 30000, onProgress });
        last = null;
        break;
      } catch (e) {
        last = e;
        try { fs.rmSync(tarPath, { force: true }); } catch { /* best effort */ }
        if (prefix !== TAR_MIRRORS[TAR_MIRRORS.length - 1]) log('↻ 换一个地址重试…', 'meta');
      }
    }
    if (last) throw new Error(`取回失败：${last.message}`);
  } else {
    log('✔ 使用已下载的源码包（6 小时内）', 'stdout');
  }

  const tmp = path.join(PLUGIN_CACHE, `x-${item.id}`.replace(/[^\w.\-]+/g, '_'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  mkdirp(tmp);
  log('▶ 解压…', 'meta');
  extractTar(tarPath, tmp, { stripComponents: 1 });
  const from = path.join(tmp, src.path);
  if (!exists(path.join(from, 'plugin.json'))) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`源码包里没有 ${src.path}/plugin.json（作者可能改了目录结构）。`);
  }

  const dest = path.join(entry.dir, 'plugins', item.id);
  if (exists(dest)) { log(`▶ 覆盖已存在的 plugins/${item.id}`, 'meta'); fs.rmSync(dest, { recursive: true, force: true }); }
  copyTree(from, dest);
  log(`✔ 已放入 plugins/${item.id}`, 'stdout');

  const packed = runTool(entry.dir, [pluginTool(entry.dir), 'pack', item.id]);
  if (!packed.ok) throw new Error(`引擎的 pack 校验没通过：\n${packed.out.slice(0, 600)}`);
  log(packed.out.split('\n').slice(-3).join('\n'), 'stdout');

  noteInstalled(entry.id, item.id, {
    id: item.id, name: item.name, version: item.version, class: item.class,
    from: `source:${src.repo}@${src.branch}/${src.path}`, at: nowIso(),
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  return { ok: true, id: item.id, from: 'source' };
}

/** Install a zip the user supplied (already on disk). The engine unpacks and checks it itself. */
export function installFromZip(entry, zipPath, { log = () => {} } = {}) {
  const support = pluginSupport(entry.dir);
  if (!support.ok) throw new Error(support.reason);
  log(`▶ 引擎安装 ${path.basename(zipPath)}…`, 'meta');
  // `--force` keeps any same-id folder by moving it to plugins/_replaced/ instead of deleting it.
  const r = runTool(entry.dir, [pluginTool(entry.dir), 'install', zipPath, '--force']);
  if (!r.ok) throw new Error(`引擎拒绝了这个包：\n${(r.out || '').slice(0, 700)}`);
  const line = r.out.split('\n').filter(Boolean).pop() || '';
  log(line, 'stdout');
  const id = /plugins[\\/]([\w.\-]+)/.exec(r.out)?.[1] || path.basename(zipPath).replace(/\.zip$/i, '').replace(/-\d+\.\d+\.\d+$/, '');
  noteInstalled(entry.id, id, { id, from: `zip:${path.basename(zipPath)}`, sha256: sha256File(zipPath), at: nowIso() });
  return { ok: true, id, from: 'zip', sha256: sha256File(zipPath) };
}

/**
 * Install from an address. We download it, check it against the expected hash when the catalogue has
 * one, report what we saw, and then hand the local file to the engine.
 *
 * The hash is checked **here** rather than left to the engine: an https install in the engine needs a
 * `--sha256` from the caller, and verifying before the file reaches the engine is the stronger order.
 */
export async function installFromUrl(entry, url, { sha256 = '', expectBytes = 0, log = () => {}, onProgress } = {}) {
  const u = String(url || '').trim();
  if (!/^https:\/\//i.test(u)) throw new Error('地址需要是 https 开头。');
  mkdirp(PLUGIN_CACHE);
  const name = (u.split('/').pop() || 'plugin.zip').replace(/[^\w.\-]+/g, '_');
  const dest = path.join(PLUGIN_CACHE, name);
  // A release asset redirects to objects.githubusercontent.com, which is as blocked as github.com on
  // some networks, so the same accelerators the rest of the launcher uses are tried first.
  const candidates = /^https:\/\/github\.com\//i.test(u) ? URL_MIRRORS.map((p) => p + u) : [u];
  let last = null;
  for (const cand of candidates) {
    log(`▶ 下载 ${cand === u ? u : cand}`, 'meta');
    try {
      await downloadFile(cand, dest, { timeout: 30000, idle: 30000, onProgress });
      last = null;
      break;
    } catch (e) {
      last = e;
      try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
      if (cand !== candidates[candidates.length - 1]) log('↻ 换一个地址重试…', 'meta');
    }
  }
  if (last) throw new Error(`下载失败：${last.message}`);
  const size = fs.statSync(dest).size;
  const hash = sha256File(dest);
  if (sha256) {
    if (hash !== sha256) {
      try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
      throw new Error(`校验失败：这个包的 sha256 与目录里记录的不一致（目录 ${sha256.slice(0, 16)}…，下载到 ${hash.slice(0, 16)}…），已丢弃。`);
    }
    log(`✔ sha256 与目录一致（${formatBytes(size)}）`, 'stdout');
  } else if (expectBytes && size !== expectBytes) {
    log(`⚠ 大小与目录记录不同（目录 ${expectBytes}，实际 ${size}）——目录里没有哈希，继续安装。`, 'meta');
  } else {
    log(`✔ 下载完成 ${formatBytes(size)}；sha256 ${hash.slice(0, 16)}…（目录里没有记录可比对）`, 'stdout');
  }
  return installFromZip(entry, dest, { log });
}

/** Remove a plugin this launcher installed. */
export function removePlugin(entry, id, { log = () => {} } = {}) {
  const rec = installedPlugins(entry.id)[id];
  if (!rec) throw new Error('这个插件不是启动器装的，无法在这里卸载。');
  const dir = path.join(entry.dir, 'plugins', id);
  if (!exists(dir)) { noteRemoved(entry.id, id); return { ok: true, already: true }; }
  fs.rmSync(dir, { recursive: true, force: true });
  log(`已删除 plugins/${id}`, 'stdout');
  noteRemoved(entry.id, id);
  return { ok: true, id };
}

function copyTree(src, dst) {
  mkdirp(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(from, to);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
}
