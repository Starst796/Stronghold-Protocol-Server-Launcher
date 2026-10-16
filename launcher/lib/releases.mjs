// launcher/lib/releases.mjs — install a version from a GitHub Release instead of a git clone.
//
// A release asset is the maintainers' own packaging of a version, and it is what most players use:
// upstream publishes 完整包 / 精简包 / 更新包, and Forge publishes a source archive, a Windows
// portable bundle and voice packs. Installing from a release therefore needs no git at all, and it is
// the only route to a version that has no useful branch to clone.
//
// Two shapes have to be handled, because the projects wrap their packages differently: upstream puts
// everything under `Stronghold-Protocol/`, while Forge's source archive sits at the zip root. Rather
// than hard-coding either, the extracted tree is searched for the source root (the directory holding
// `package.json` and `tools/setup.mjs`) and that directory becomes the version.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, gitUrlCandidates } from './config.mjs';
import { exists, readJson, writeJsonAtomic, mkdirp, formatBytes, runCapture, fetchWithTimeout, compareVersions, nowIso } from './util.mjs';
import { gitCommand, downloadFile } from './repo.mjs';
import { unzipToDir } from './zip.mjs';

const CACHE_DIR = path.join(ROOT, '.cache');
const RELEASE_CACHE = path.join(CACHE_DIR, 'releases.json');
const RELEASE_CACHE_MS = 30 * 60 * 1000;
const API_BASE = 'https://api.github.com/repos';

/** api.github.com answers through these, in order (`prefix ''` = direct). ghfast does not proxy the API. */
const API_MIRRORS = [{ prefix: '' }, { prefix: 'https://gh-proxy.com/' }, { prefix: 'https://ghproxy.net/' }];
const ASSET_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/', ''];

/**
 * The projects we can install a version from.
 *
 * `assetNames` is the fallback when the API is rate-limited: a tag is turned into its asset names by
 * pattern, and the ones that answer a HEAD request are offered. Keeping the patterns here (rather than
 * guessing) is what makes that fallback predictable.
 */
export const RELEASE_SOURCES = [
  {
    id: 'upstream',
    label: '上游 Stronghold-Protocol',
    slug: 'sganggs/Stronghold-Protocol',
    desc: '官方原作。精简包不含素材（配合共享素材只下约 25 MB），完整包自带素材。',
    recommended: 'lite',
    assetNames: (tag) => ({
      lite: `Stronghold-Protocol-${tag}-lite.zip`,
      full: `Stronghold-Protocol-${tag}.zip`,
      update: `Stronghold-Protocol-${tag}-update.zip`,
      assets: `Stronghold-Protocol-${tag}-assets.zip`,
    }),
  },
  {
    id: 'forge',
    label: 'Forge 工坊版',
    slug: 'XiaMo233M/Stronghold-Protocol-Forge',
    desc: '带创意工坊与插件系统的衍生版（版本号形如 Forge-上游）。源码包不含素材，另有 Windows 便携整合包与语音包。',
    recommended: 'src',
    assetNames: (tag) => {
      const bare = tag.replace(/^v/i, '');
      const base = `Stronghold-Protocol-Forge-${bare}`;
      return {
        src: `${base}-src.zip`, lite: `${base}-lite.zip`, liteJp: `${base}-lite-jp.zip`,
        full: `${base}.zip`, update: `${base}-update.zip`,
        voices: `${base}-voices-cn-en-kr.zip`, win: `${base}-win-x64.zip`,
      };
    },
  },
];

export const releaseSourceById = (id) => RELEASE_SOURCES.find((s) => s.id === id) || RELEASE_SOURCES[0];

/**
 * What an asset is, and whether it can become a version on its own. Learned from the real releases:
 * an `-update.zip` is a diff against one specific earlier package, and a voice pack is data.
 */
export const ASSET_KINDS = {
  src: { label: '源码包', usable: true, hint: '推荐：很小，素材走共享区' },
  lite: { label: '精简包', usable: true, hint: '推荐：不含素材，素材走共享区' },
  liteJp: { label: '精简包（含日文语音）', usable: true, hint: '含日文语音' },
  full: { label: '完整包', usable: true, hint: '自带素材（约 580 MB），不需要共享区' },
  update: { label: '增量更新包', usable: false, hint: '只能覆盖某个指定的旧版本，不能单独安装' },
  voices: { label: '语音包', usable: false, hint: '只有语音数据，不是一份可运行版本' },
  assets: { label: '素材包', usable: false, hint: '只有素材，不是一份可运行版本' },
  win: { label: 'Windows 便携整合包', usable: false, hint: '自带 Node 与启动脚本的整合包，只适用于 Windows，且不经过启动器管理' },
  other: { label: '其它文件', usable: false, hint: '' },
};

/** Best guess at an asset's kind from its name (the API gives no other signal). */
export function classifyAsset(name) {
  const n = String(name || '').toLowerCase();
  if (/voices?[-_]/.test(n) || /-voice/.test(n)) return 'voices';
  if (/-assets\.zip$/.test(n)) return 'assets';
  if (/-update\.zip$/.test(n)) return 'update';
  if (/-win(-x64)?\.zip$/.test(n) || /win-x64/.test(n)) return 'win';
  if (/-src\.zip$/.test(n)) return 'src';
  if (/-lite-jp\.zip$/.test(n)) return 'liteJp';
  if (/-lite\.zip$/.test(n)) return 'lite';
  if (/\.zip$/.test(n)) return 'full';
  return 'other';
}

/** Tag → the versions inside it. Forge tags are `0.19.0-0.3.0` (Forge build · upstream build). */
export function describeTag(tag) {
  const t = String(tag || '').replace(/^v/i, '');
  const m = /^(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)/.exec(t);
  if (m) return { version: t, forge: m[1], upstream: m[2] };
  return { version: t, forge: '', upstream: '' };
}

const withApiMirror = (url, prefix) => (prefix ? `${prefix}${url}` : url);

async function apiJson(url, { timeout = 20000 } = {}) {
  let last = null;
  for (const m of API_MIRRORS) {
    try {
      const res = await fetchWithTimeout(withApiMirror(url, m.prefix), {
        timeout,
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Stronghold-Protocol-Server-Launcher' },
      });
      if (res.status === 403 || res.status === 429) throw new Error(`GitHub API 限流（HTTP ${res.status}）`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`读取 release 列表失败：${last?.message || last}`);
}

/** Turn one API release into the shape the UI needs. */
function shapeRelease(rel) {
  const assets = (rel.assets || []).map((a) => {
    const kind = classifyAsset(a.name);
    return {
      name: a.name,
      size: a.size || 0,
      url: a.browser_download_url,
      kind,
      label: ASSET_KINDS[kind].label,
      usable: ASSET_KINDS[kind].usable,
      hint: ASSET_KINDS[kind].hint,
    };
  }).sort((a, b) => (Number(b.usable) - Number(a.usable)) || a.size - b.size);
  return {
    tag: rel.tag_name,
    name: rel.name || rel.tag_name,
    publishedAt: rel.published_at || rel.created_at || '',
    prerelease: !!rel.prerelease,
    notes: String(rel.body || '').slice(0, 4000),
    ...describeTag(rel.tag_name),
    assets,
  };
}

/**
 * Every release of a source, newest first. Cached for half an hour: the unauthenticated GitHub API
 * allows only 60 requests an hour per address, and a launcher start-up that spent one every time would
 * exhaust that on its own.
 * @param {string} sourceId
 * @param {{force?:boolean, log?:(line:string,stream?:string)=>void}} [o]
 */
export async function listReleases(sourceId, { force = false, log = () => {} } = {}) {
  const src = releaseSourceById(sourceId);
  const cache = readJson(RELEASE_CACHE, {});
  const hit = cache[src.id];
  if (!force && hit && Array.isArray(hit.releases) && Date.now() - (hit.at || 0) < RELEASE_CACHE_MS) {
    return { ...hit, cached: true };
  }
  try {
    const raw = await apiJson(`${API_BASE}/${src.slug}/releases?per_page=30`);
    if (!Array.isArray(raw)) throw new Error('返回格式不是数组');
    const releases = raw.map(shapeRelease);
    const next = { ...cache, [src.id]: { at: Date.now(), fetchedAt: nowIso(), viaApi: true, releases, error: null } };
    writeJsonAtomic(RELEASE_CACHE, next);
    return { ...next[src.id], cached: false };
  } catch (e) {
    // Rate limits and blocked hosts are both likely; tags still come from git, which the launcher
    // already reaches through mirrors, and asset names follow the project's own pattern.
    log(`无法读取 ${src.label} 的 release 列表（${e.message}）；改用 git 标签推断…`, 'meta');
    const releases = await releasesFromTags(src, { log });
    const next = { ...cache, [src.id]: { at: Date.now(), fetchedAt: nowIso(), viaApi: false, releases, error: e.message } };
    writeJsonAtomic(RELEASE_CACHE, next);
    return { ...next[src.id], cached: false };
  }
}

/** Fallback: list tags with git, then keep the assets whose URLs answer a HEAD request. */
async function releasesFromTags(src, { log = () => {} } = {}) {
  const git = gitCommand();
  if (!git) return [];
  const repoUrl = `https://github.com/${src.slug}.git`;
  let out = '';
  for (const url of gitUrlCandidates({ downloadSource: 'github' }, repoUrl)) {
    const r = runCapture(git, ['ls-remote', '--tags', '--refs', url], { timeout: 60000, env: { GIT_TERMINAL_PROMPT: '0' } });
    if (r.ok && r.out) { out = r.out; break; }
  }
  const tags = out.split('\n').map((l) => l.trim().split(/\s+/)[1] || '')
    .filter((t) => /^refs\/tags\//.test(t)).map((t) => t.replace(/^refs\/tags\//, ''))
    .filter((t) => /^v?\d/.test(t));
  tags.sort((a, b) => compareVersions(b, a));
  const releases = [];
  for (const tag of tags.slice(0, 12)) {
    const names = src.assetNames(tag);
    const assets = [];
    for (const [kind, name] of Object.entries(names)) {
      const url = `https://github.com/${src.slug}/releases/download/${tag}/${name}`;
      const ok = await headOk(url);
      if (!ok) continue;
      const k = ASSET_KINDS[kind] ? kind : classifyAsset(name);
      assets.push({ name, size: 0, url, kind: k, label: ASSET_KINDS[k].label, usable: ASSET_KINDS[k].usable, hint: ASSET_KINDS[k].hint });
    }
    if (!assets.length) continue;
    assets.sort((a, b) => Number(b.usable) - Number(a.usable));
    releases.push({
      tag, name: tag, publishedAt: '', prerelease: false, notes: '（无法读取发布说明：GitHub API 不可用，列表由 git 标签推断）',
      ...describeTag(tag), assets,
    });
  }
  log(`已按 git 标签推断出 ${releases.length} 个版本（大小未知）。`, 'meta');
  return releases;
}

async function headOk(url) {
  for (const prefix of ASSET_MIRRORS) {
    try {
      const res = await fetchWithTimeout(prefix ? `${prefix}${url}` : url, { method: 'HEAD', timeout: 15000, redirect: 'follow' });
      if (res.ok) return true;
    } catch { /* try the next mirror */ }
  }
  return false;
}

/** The asset a plain 「安装」 should pick, honouring the source's recommendation. */
export function defaultAsset(release, src) {
  const usable = (release.assets || []).filter((a) => a.usable);
  return usable.find((a) => a.kind === src.recommended) || usable[0] || null;
}

/**
 * Download one asset and unpack it into `entry.dir`.
 *
 * The download is kept in `.cache/` and only removed after a successful unpack, so a failed install can
 * be retried without transferring again.
 * @param {object} cfg launcher config
 * @param {object} entry the version being installed
 * @param {{tag:string, asset:{name:string,url:string,size?:number}, log?:Function, onProgress?:Function}} o
 */
export async function installRelease(cfg, entry, { tag, asset, log = () => {}, onProgress } = {}) {
  const src = releaseSourceById(entry.release?.sourceId);
  const dlDir = path.join(CACHE_DIR, 'downloads');
  mkdirp(dlDir);
  const zipPath = path.join(dlDir, `${entry.id}--${asset.name}`.replace(/[^\w.\-]+/g, '_'));
  const tmpDir = path.join(CACHE_DIR, `extract-${entry.id}`);
  rmrf(tmpDir);
  mkdirp(tmpDir);

  const needDownload = !exists(zipPath) || (asset.size > 0 && fs.statSync(zipPath).size !== asset.size);
  if (needDownload) {
    log(`▶ 下载 ${asset.name}${asset.size ? `（${formatBytes(asset.size)}）` : ''}`, 'meta');
    let last = null;
    for (const prefix of ASSET_MIRRORS) {
      try {
        await downloadFile(prefix ? `${prefix}${asset.url}` : asset.url, zipPath, { timeout: 30 * 60 * 1000, onProgress });
        last = null;
        break;
      } catch (e) {
        last = e;
        rmrf(zipPath, true);
        if (prefix !== ASSET_MIRRORS[ASSET_MIRRORS.length - 1]) log('↻ 下载失败，换一个地址重试…', 'meta');
      }
    }
    if (last) throw new Error(`下载失败：${last.message}`);
  } else {
    log(`✔ 已有下载缓存：${asset.name}`, 'stdout');
  }

  log(`▶ 解压 ${asset.name}`, 'meta');
  const r = unzipToDir(zipPath, tmpDir);
  log(`  解出 ${r.files} 个文件（${formatBytes(r.bytes)}）`, 'stdout');

  const root = findSourceRoot(tmpDir);
  if (!root) {
    rmrf(tmpDir);
    throw new Error(
      `这个资产不是可安装的源码包（解压后找不到 package.json 与 tools/setup.mjs）：${asset.name}。`
      + '请换一个「源码包 / 精简包 / 完整包」。',
    );
  }

  rmrf(entry.dir);
  mkdirp(path.dirname(entry.dir));
  log(`▶ 放入版本目录：${entry.dir}`, 'meta');
  moveDir(root, entry.dir);
  rmrf(tmpDir);
  rmrf(zipPath, true);
  return { dir: entry.dir, files: r.files, bytes: r.bytes, asset: asset.name, tag, sourceId: src.id };
}

/**
 * The directory that holds the actual game source: `package.json` + `tools/setup.mjs`, either at the
 * root, inside a single wrapping folder, or one level down. Upstream wraps, a source archive does not.
 */
export function findSourceRoot(tmpDir, depth = 0) {
  if (depth > 2) return null;
  const looksRight = (dir) => exists(path.join(dir, 'package.json')) && exists(path.join(dir, 'tools', 'setup.mjs'));
  if (looksRight(tmpDir)) return tmpDir;
  let entries;
  try { entries = fs.readdirSync(tmpDir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const found = findSourceRoot(path.join(tmpDir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Update a release-installed version by unpacking the newest tag's same-kind asset over it.
 *
 * Everything the user or the server accumulates is preserved: dependencies, the linked art, the
 * shared caches, and — importantly — installed plugins, workshop packs and server state, none of which
 * are part of a release package.
 */
export async function updateRelease(cfg, entry, { tag, asset, log = () => {}, onProgress } = {}) {
  if (!asset) throw new Error('这个版本没有记录安装时用的资产，无法自动更新；请重新安装。');
  const tmpDir = path.join(CACHE_DIR, `update-${entry.id}`);
  rmrf(tmpDir);
  mkdirp(tmpDir);
  await installRelease(cfg, { ...entry, dir: tmpDir }, { tag, asset, log, onProgress });
  const root = findSourceRoot(tmpDir);
  if (!root) { rmrf(tmpDir); throw new Error('新包里找不到源码根目录。'); }
  log('▶ 覆盖版本目录（保留依赖、素材与插件）…', 'meta');
  copyTree(root, entry.dir, PRESERVE_ON_RELEASE);
  rmrf(tmpDir);
  return { dir: entry.dir, tag, asset: asset.name };
}

/** Directories that must survive a release update or reinstall. */
export const PRESERVE_ON_RELEASE = [
  'node_modules', '.cache', '.venv-extract', 'public/assets', 'public/fonts', 'public/vendor',
  'plugins', 'workshop', 'var', '.git', 'logs', 'packs',
];

function rmrf(p, quiet = false) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { if (!quiet) throw e; }
}

/** Move a directory, falling back to a copy across devices. */
function moveDir(src, dst) {
  try {
    fs.renameSync(src, dst);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
  }
  copyTree(src, dst, []);
  rmrf(src);
}

function copyTree(src, dst, preserve) {
  mkdirp(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (preserve.includes(e.name) && exists(path.join(dst, e.name))) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(from, to, []);
    else if (e.isFile()) { mkdirp(path.dirname(to)); fs.copyFileSync(from, to); }
  }
}

/**
 * The tag and asset an update should use: the newest release's asset of the same kind, so a source
 * install does not suddenly pull a 900 MB portable bundle. Falls back to the same file name, then to
 * anything installable.
 * @returns {Promise<{tag:string, asset:object}|null>}
 */
export async function updateAssetFor(entry, { log = () => {} } = {}) {
  const rec = entry.release;
  if (!rec?.sourceId) return null;
  const listed = await listReleases(rec.sourceId, { log });
  const newest = (listed.releases || [])[0];
  if (!newest) return null;
  const assets = newest.assets || [];
  const asset = assets.find((a) => a.kind === rec.assetKind && a.usable)
    || assets.find((a) => a.name === rec.assetName)
    || assets.find((a) => a.usable);
  return asset ? { tag: newest.tag, asset } : null;
}

/**
 * Is there a newer release for this version? Compares the recorded tag against the newest release of
 * the same source, counting only assets of the same kind.
 */
export async function checkReleaseUpdate(entry, { log = () => {} } = {}) {
  const out = { state: 'unknown', local: entry.release?.tag || null, remote: null, incoming: [] };
  const rec = entry.release;
  if (!rec?.sourceId) return { ...out, state: 'norepo' };
  let listed;
  try {
    listed = await listReleases(rec.sourceId, { log });
  } catch (e) {
    log(`读取 release 列表失败：${e.message}`);
    return out;
  }
  const newest = (listed.releases || [])[0];
  if (!newest) return out;
  out.remote = newest.tag;
  const assets = newest.assets || [];
  const same = assets.find((a) => a.kind === rec.assetKind && a.usable) || assets.find((a) => a.usable);
  out.incoming = same ? [{ hash: newest.tag, date: (newest.publishedAt || '').slice(0, 10), subject: `升级到 ${newest.tag}` }] : [];
  if (compareVersions(newest.tag, rec.tag) <= 0) return { ...out, state: 'equal' };
  return { ...out, state: 'behind' };
}
