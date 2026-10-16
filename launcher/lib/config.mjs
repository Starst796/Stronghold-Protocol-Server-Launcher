// launcher/lib/config.mjs — persistent launcher configuration, built-in presets and
// the list of download sources.
//
// The config file lives next to the launcher (`launcher.config.json`) so the whole
// thing stays portable: copy the folder anywhere, the game install path is stored
// relative to the launcher unless the user picks an absolute one.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic, exists, IS_WIN, IS_MAC } from './util.mjs';

/** Launcher root (the folder that contains `launcher/`). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_FILE = path.join(ROOT, 'launcher.config.json');
export const LOG_FILE = path.join(ROOT, 'launcher.log');

/** Default game install directory: `<launcher>/game`. */
export const DEFAULT_INSTALL_DIR = path.join(ROOT, 'game');

/** Where the version folders live (`<launcher>/installs/<id>`). */
export const INSTALLS_DIR = path.join(ROOT, 'installs');

/** Default shared directory: the art / audio every version links to instead of downloading twice. */
export const DEFAULT_SHARED_DIR = path.join(ROOT, 'shared');

export const REPO_SLUG = 'sganggs/Stronghold-Protocol';
export const REPO_URL = `https://github.com/${REPO_SLUG}`;
export const BRANCH = 'master';

/**
 * The launcher's *own* repository, used for self-update. A public HTTPS URL is the default on
 * purpose: an SSH remote (`git@github.com:…`) would only work for the machine that owns the key,
 * so nobody else could ever auto-update.
 */
export const SELF_REPO_SLUG = 'Starst796/Stronghold-Protocol-Server-Launcher';
export const SELF_REPO_URL = `https://github.com/${SELF_REPO_SLUG}`;

/**
 * Our relay repository for mods (see lib/mods.mjs). A fork's customization is a change to the game's
 * *source*, which upstream's data-only packs cannot carry, so each fork is packaged once against a
 * pinned upstream base and published here instead. Public HTTPS by default for the same reason as the
 * launcher's own repository: every user must be able to read it without an SSH key.
 */
export const MODS_REPO_SLUG = 'Starst796/Stronghold-Protocol-Mods';
export const MODS_REPO_URL = `https://github.com/${MODS_REPO_SLUG}`;

/**
 * Download sources. Direct github.com git access is blocked on some networks,
 * so several community mirrors are offered; the UI can probe them ("测试速度").
 * `git` = clone URL, `archive` = tar.gz of the branch (no git needed).
 * `asset` = the art / audio route this source implies (see `assetRouteOf`).
 */
export const SOURCES = [
  {
    id: 'github',
    label: 'GitHub 官方',
    desc: 'github.com 原始地址，海外线路最稳；部分国内网络无法直连。',
    git: `https://github.com/${REPO_SLUG}.git`,
    archive: `https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${BRANCH}`,
    raw: `https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/`,
    asset: { source: 'direct' },
  },
  {
    id: 'ghproxy',
    label: 'GitHub 加速 · gh-proxy.com',
    desc: '公共加速代理，支持 git clone 与压缩包下载，国内通常可用。',
    git: `https://gh-proxy.com/https://github.com/${REPO_SLUG}.git`,
    archive: `https://gh-proxy.com/https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.tar.gz`,
    raw: `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/`,
    asset: { source: 'mirror', proxy: 'https://gh-proxy.com/' },
  },
  {
    id: 'ghfast',
    label: 'GitHub 加速 · ghfast.top',
    desc: '另一个公共加速代理，与 gh-proxy 互为备份。',
    git: `https://ghfast.top/https://github.com/${REPO_SLUG}.git`,
    archive: `https://ghfast.top/https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.tar.gz`,
    raw: `https://ghfast.top/https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/`,
    asset: { source: 'mirror', proxy: 'https://ghfast.top/' },
  },
  {
    id: 'ghproxy-net',
    label: 'GitHub 加速 · ghproxy.net',
    desc: '公共加速代理，备用线路。',
    git: `https://ghproxy.net/https://github.com/${REPO_SLUG}.git`,
    archive: `https://ghproxy.net/https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.tar.gz`,
    raw: `https://ghproxy.net/https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/`,
    asset: { source: 'mirror', proxy: 'https://ghproxy.net/' },
  },
  {
    id: 'gitclone',
    label: 'gitclone 镜像',
    desc: 'gitclone.com 缓存镜像，只支持 clone（更新可能滞后）。',
    git: `https://gitclone.com/github.com/${REPO_SLUG}.git`,
    archive: `https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${BRANCH}`,
    raw: `https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/`,
    // gitclone only caches the git clone; its raw files are not proxied.
    asset: { source: 'direct' },
  },
  {
    id: 'gitee-starst796',
    label: 'Gitee 镜像（Starst796）',
    desc: 'gitee.com 镜像，国内访问稳定，但更新可能滞后。',
    git: `https://gitee.com/Starst796/Stronghold-Protocol.git`,
    archive: `https://gitee.com/Starst796/Stronghold-Protocol/repository/archive/master.tar.gz`,
    raw: `https://gitee.com/Starst796/Stronghold-Protocol/raw/master/`,
    // Gitee mirrors the game repo, not the art dumps (yuanyan / ArknightsAssets / Ark-Models / Kengxxiao):
    // the art goes through the GitHub prefix proxy with the tool's default prefix.
    asset: { source: 'mirror' },
  }
];

export const sourceById = (id) => SOURCES.find((s) => s.id === id) || SOURCES[0];

/**
 * Which route the art / audio download takes for the chosen download source, i.e. what the launcher
 * passes to the game's `tools/fetch-assets.mjs` (`--asset-source`, `SP_GITHUB_PROXY`). Picking an
 * accelerated source must accelerate the assets too — the asset dumps always come from GitHub, even
 * when the game repo itself was cloned from Gitee.
 * @param {object} cfg launcher config (`downloadSource`)
 * @returns {{source:'direct'|'mirror', proxy?:string}}
 */
export const assetRouteOf = (cfg) => sourceById(cfg?.downloadSource).asset || { source: 'direct' };

/**
 * How each download source reaches an *arbitrary* GitHub repository. The `git` URLs above only cover
 * the official repo, but a fork is cloned by the URL the user typed — on a network where github.com is
 * unreachable that clone sits on the OS connect timeout (75 s on macOS) and then fails, so a user who
 * picked a mirror still cannot install a fork. Applying the same proxy to the fork's URL fixes it.
 *
 * `prefix` is prepended to `https://github.com/…`; `dropScheme` marks gitclone.com, which wants
 * `https://gitclone.com/github.com/…` instead of nesting a second scheme inside the path.
 */
const GITHUB_CLONE_MIRRORS = [
  { id: 'ghproxy', prefix: 'https://gh-proxy.com/' },
  { id: 'ghfast', prefix: 'https://ghfast.top/' },
  { id: 'ghproxy-net', prefix: 'https://ghproxy.net/' },
  { id: 'gitclone', prefix: 'https://gitclone.com/', dropScheme: true },
];

/** Anything that cannot be a remote we proxy: local paths, `file://`, Windows paths, relative refs. */
const LOCAL_URL_RE = /^(file:\/\/|\/|[A-Za-z]:[\\/]|\.)/;

/**
 * Normalize a GitHub URL of any shape (plain https, already proxied, `git@`, `ssh://`) to
 * `https://github.com/owner/repo.git`. Returns `''` for anything that is not a GitHub repository.
 * @param {string} url
 * @returns {string}
 */
export function githubHttpsUrl(url) {
  const raw = String(url || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!raw || LOCAL_URL_RE.test(raw)) return '';
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(raw);
  return m ? `https://github.com/${m[1]}/${m[2]}.git` : '';
}

const mirrorGitUrl = (mirror, ghUrl) => mirror.prefix + (mirror.dropScheme ? ghUrl.replace(/^https:\/\//i, '') : ghUrl);

/**
 * The clone/fetch URLs to try for `repo`, best first. A user who selected a mirror is on a network
 * where the direct URL does not work, so that route goes first and direct github.com is only a
 * fallback; an `ssh` URL stays first because it may carry credentials a public proxy cannot.
 * @param {object} cfg launcher config (`downloadSource`)
 * @param {string} repo the version's recorded repository URL
 * @returns {string[]} at least one URL (the original when it is not a GitHub repository)
 */
export function gitUrlCandidates(cfg, repo) {
  const url = String(repo || '').trim();
  const out = [];
  const push = (u) => { if (u && !out.includes(u)) out.push(u); };
  const gh = githubHttpsUrl(url);
  if (!gh) return url ? [url] : [];
  const isSsh = /^(git@|ssh:\/\/)/i.test(url);
  const preferred = GITHUB_CLONE_MIRRORS.find((m) => m.id === cfg?.downloadSource);
  if (preferred && !isSsh) push(mirrorGitUrl(preferred, gh));
  // `https://github.com/o/r` and `…/r.git` name the same remote, so keeping both would only double
  // the wait on a network where that host is blocked.
  if (url !== gh.replace(/\.git$/, '')) push(url);
  if (preferred && isSsh) push(mirrorGitUrl(preferred, gh));
  push(gh);
  for (const m of GITHUB_CLONE_MIRRORS) push(mirrorGitUrl(m, gh));
  return out;
}

/**
 * Built-in launch presets. A preset only touches the runtime environment variables
 * the game server understands (see the project README "端口与配置").
 */
export const BUILTIN_PRESETS = [
  {
    id: 'default',
    label: '默认（推荐）',
    desc: '各玩家浏览器模拟战斗，服务器负载最低，适合大多数情况。',
    values: { port: 3000, host: '0.0.0.0', combat: 'client', verify: 'off', trustProxy: 'auto', debug: false },
  },
  {
    id: 'solo',
    label: '单机 / 只开本机',
    desc: '只监听本机，朋友无法连接；最省心、最安全。',
    values: { port: 3000, host: '127.0.0.1', combat: 'client', verify: 'off', trustProxy: 'auto', debug: false },
  },
  {
    id: 'coop',
    label: '局域网开黑（1–4 人）',
    desc: '同一 Wi-Fi／路由器的朋友可以直接连进来。',
    values: { port: 3000, host: '0.0.0.0', combat: 'client', verify: 'off', trustProxy: 'auto', debug: false },
  },
  {
    id: 'proxy',
    label: '公网 / 反向代理',
    desc: '放在 cloudflared 等反向代理后面时使用（信任转发头）。',
    values: { port: 3000, host: '127.0.0.1', combat: 'client', verify: 'off', trustProxy: '1', debug: false },
  },
  {
    id: 'strict',
    label: '服务器复算（防作弊）',
    desc: '服务器模拟战斗并全面复算，CPU 占用明显更高，小主机慎用。',
    values: { port: 3000, host: '0.0.0.0', combat: 'server', verify: 'all', trustProxy: 'auto', debug: false },
  },
  {
    id: 'debug',
    label: '调试 / 排错',
    desc: '打开详细日志（DEBUG），反馈问题时使用。',
    values: { port: 3000, host: '0.0.0.0', combat: 'client', verify: 'off', trustProxy: 'auto', debug: true },
  },
];

export const allPresets = (cfg) => [
  ...BUILTIN_PRESETS,
  ...Object.entries(cfg.customPresets || {}).map(([id, p]) => ({ id, label: p.label || id, desc: p.desc || '', custom: true, values: p.values })),
];

export const DEFAULT_CONFIG = {
  configVersion: 1,
  installDir: '',            // '' → DEFAULT_INSTALL_DIR（兼容字段：等于当前版本的目录）
  installs: [],              // the version registry (lib/installs.mjs): [{id,label,kind,repo,ref,dir,commit,linkMode}]
  activeInstallId: '',       // which entry above is the one that runs
  shareAssets: true,         // let every version share one copy of public/assets + public/fonts
  sharedAssetsDir: '',       // '' → DEFAULT_SHARED_DIR
  downloadSource: 'github',
  clientDir: '',             // AssetBundle root of a local Arknights client ('' → setup.mjs auto-detects)
  extractLocal: true,        // let setup.mjs extract the official local-client art when a client is found
  port: 3000,
  host: '0.0.0.0',
  combat: 'client',          // client | server      → SP_COMBAT
  verify: 'off',             // off | sample | all   → SP_VERIFY
  trustProxy: 'auto',        // auto | 1 | 0         → TRUST_PROXY
  debug: false,              // → DEBUG
  openBrowser: true,
  autoStart: false,          // start the server as soon as the launcher opens
  autoUpdateCheck: true,     // check GitHub for updates on open
  autoUpdateSelf: true,      // update the launcher itself from its own repo at startup
  selfRepoUrl: SELF_REPO_URL, // public HTTPS by default so every user can self-update
  modsRepoUrl: MODS_REPO_URL, // the relay repository whose index.json lists the mods (lib/mods.mjs)
  enabledMods: [],           // mod ids the user selected; applied to the install on demand
  assetConcurrency: 16,      // tools/fetch-assets.mjs --concurrency
  activePreset: 'default',
  customPresets: {},
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * One version entry, sanitised. `dir` is stored absolute; the rest is plain text. Invalid entries are
 * dropped rather than fixed up (a half-valid entry would resolve to the wrong directory).
 * @param {unknown} e
 * @param {number} i
 */
function coerceInstall(e, i) {
  if (!isObj(e)) return null;
  const dir = str(e.dir, 500);
  if (!dir || !path.isAbsolute(dir)) return null;
  const kind = e.kind === 'upstream' ? 'upstream' : 'fork';
  // A version can come from a git remote or from a published release asset; the second has no working
  // copy, so its install source has to survive normalisation or the next deploy would try to clone it.
  const isRelease = e.source === 'release';
  return {
    id: str(e.id, 64) || `install-${i + 1}`,
    label: str(e.label, 80) || `版本 ${i + 1}`,
    kind,
    source: isRelease ? 'release' : '',
    sourceUrl: str(e.sourceUrl, 300),
    release: isRelease ? coerceRelease(e.release) : null,
    repo: str(e.repo, 300),
    ref: str(e.ref, 120),
    dir,
    commit: str(e.commit, 40),
    linkMode: str(e.linkMode, 20),
    addedAt: str(e.addedAt, 40),
  };
}

/** The recorded release a version was installed from; null when it is unusable. */
function coerceRelease(r) {
  if (!isObj(r)) return null;
  const tag = str(r.tag, 80);
  const assetUrl = str(r.assetUrl, 500);
  if (!tag || !/^https:\/\//.test(assetUrl)) return null;
  return {
    sourceId: str(r.sourceId, 40),
    slug: str(r.slug, 120),
    tag,
    assetName: str(r.assetName, 200),
    assetUrl,
    assetKind: str(r.assetKind, 20),
    size: Math.max(0, Number(r.size) || 0),
  };
}

const COERCE = {
  port: (v) => Math.min(65535, Math.max(1, Number(v) || 3000)),
  host: (v) => String(v || '0.0.0.0'),
  combat: (v) => (String(v) === 'server' ? 'server' : 'client'),
  verify: (v) => (['sample', 'all'].includes(String(v)) ? String(v) : 'off'),
  trustProxy: (v) => ([ 'auto', '1', '0' ].includes(String(v)) ? String(v) : 'auto'),
  debug: (v) => !!v,
  openBrowser: (v) => v !== false,
  autoStart: (v) => !!v,
  autoUpdateCheck: (v) => v !== false,
  autoUpdateSelf: (v) => v !== false,
  selfRepoUrl: (v) => String(v || '').trim(),
  modsRepoUrl: (v) => String(v || '').trim(),
  enabledMods: (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 64) : []),
  assetConcurrency: (v) => Math.min(64, Math.max(1, Number(v) || 16)),
  installDir: (v) => String(v || ''),
  installs: (v) => (Array.isArray(v) ? v.map(coerceInstall).filter(Boolean).slice(0, 32) : []),
  activeInstallId: (v) => String(v || '').trim().slice(0, 64),
  shareAssets: (v) => v !== false,
  sharedAssetsDir: (v) => String(v || '').trim(),
  clientDir: (v) => String(v || '').trim(),
  extractLocal: (v) => v !== false,
  downloadSource: (v) => (SOURCES.some((s) => s.id === v) ? String(v) : 'github'),
  activePreset: (v) => String(v || 'default'),
};

/** Load, merge and sanitise the config (never throws). */
export function loadConfig() {
  const raw = readJson(CONFIG_FILE, {}) || {};
  const cfg = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (raw[key] === undefined) continue;
    cfg[key] = COERCE[key] ? COERCE[key](raw[key]) : raw[key];
  }
  cfg.customPresets = (raw.customPresets && typeof raw.customPresets === 'object') ? raw.customPresets : {};
  if (cfg.installDir !== '' && !path.isAbsolute(cfg.installDir)) cfg.installDir = path.resolve(ROOT, cfg.installDir);
  if (cfg.clientDir !== '' && !path.isAbsolute(cfg.clientDir)) cfg.clientDir = path.resolve(ROOT, cfg.clientDir);
  return cfg;
}

export function saveConfig(cfg) {
  writeJsonAtomic(CONFIG_FILE, cfg);
  return cfg;
}

/** Patch + sanitise + persist in one go; returns the new config. */
export function patchConfig(patch) {
  const cur = loadConfig();
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_CONFIG)) continue;
    next[k] = COERCE[k] ? COERCE[k](v) : v;
  }
  if (next.installDir && !path.isAbsolute(next.installDir)) next.installDir = path.resolve(ROOT, next.installDir);
  if (next.clientDir && !path.isAbsolute(next.clientDir)) next.clientDir = path.resolve(ROOT, next.clientDir);
  if (next.sharedAssetsDir && !path.isAbsolute(next.sharedAssetsDir)) next.sharedAssetsDir = path.resolve(ROOT, next.sharedAssetsDir);
  return saveConfig(next);
}

/** The active version entry, or null. */
export const activeInstall = (cfg) => (cfg.installs || []).find((i) => i.id === cfg.activeInstallId) || null;

/**
 * Absolute directory of the game to run: the active version's folder, else the legacy `installDir`.
 * Keeping this one function authoritative means every existing caller (repo, game, version, …)
 * follows the selected version without knowing about the registry.
 */
export const installDirOf = (cfg) => (activeInstall(cfg)?.dir || cfg.installDir || DEFAULT_INSTALL_DIR);

/** Absolute directory of the shared asset store ('' → DEFAULT_SHARED_DIR). */
export const sharedDirOf = (cfg) => (cfg.sharedAssetsDir || DEFAULT_SHARED_DIR);

/** The environment variables the game server reads (see the project README). */
export function serverEnv(cfg) {
  const env = {
    PORT: String(cfg.port),
    HOST: cfg.host,
    SP_COMBAT: cfg.combat,
    SP_VERIFY: cfg.verify,
    TRUST_PROXY: cfg.trustProxy,
  };
  if (cfg.debug) env.DEBUG = '1';
  return env;
}

/** Can this machine run the launcher's own start scripts by double-clicking? */
export const doubleClickHint = IS_WIN ? '双击「启动器.bat」' : IS_MAC ? '双击「启动器.command」' : '运行 ./start.sh';
