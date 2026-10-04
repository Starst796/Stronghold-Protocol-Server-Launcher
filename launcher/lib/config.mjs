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
 * Download sources. Direct github.com git access is blocked on some networks,
 * so several community mirrors are offered; the UI can probe them ("测试速度").
 * `git` = clone URL, `archive` = tar.gz of the branch (no git needed).
 */
export const SOURCES = [
  {
    id: 'github',
    label: 'GitHub 官方',
    desc: 'github.com 原始地址，海外线路最稳；部分国内网络无法直连。',
    git: `https://github.com/${REPO_SLUG}.git`,
    archive: `https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${BRANCH}`,
    raw: `https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/`,
  },
  {
    id: 'ghproxy',
    label: 'GitHub 加速 · gh-proxy.com',
    desc: '公共加速代理，支持 git clone 与压缩包下载，国内通常可用。',
    git: `https://gh-proxy.com/https://github.com/${REPO_SLUG}.git`,
    archive: `https://gh-proxy.com/https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.tar.gz`,
    raw: `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/`,
  },
  {
    id: 'ghfast',
    label: 'GitHub 加速 · ghfast.top',
    desc: '另一个公共加速代理，与 gh-proxy 互为备份。',
    git: `https://ghfast.top/https://github.com/${REPO_SLUG}.git`,
    archive: `https://ghfast.top/https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.tar.gz`,
    raw: `https://ghfast.top/https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/`,
  },
  {
    id: 'ghproxy-net',
    label: 'GitHub 加速 · ghproxy.net',
    desc: '公共加速代理，备用线路。',
    git: `https://ghproxy.net/https://github.com/${REPO_SLUG}.git`,
    archive: `https://ghproxy.net/https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.tar.gz`,
    raw: `https://ghproxy.net/https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/`,
  },
  {
    id: 'gitclone',
    label: 'gitclone 镜像',
    desc: 'gitclone.com 缓存镜像，只支持 clone（更新可能滞后）。',
    git: `https://gitclone.com/github.com/${REPO_SLUG}.git`,
    archive: `https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${BRANCH}`,
    raw: `https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/`,
  },
];

export const sourceById = (id) => SOURCES.find((s) => s.id === id) || SOURCES[0];

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
  installDir: '',            // '' → DEFAULT_INSTALL_DIR
  downloadSource: 'github',
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
  assetConcurrency: 16,      // tools/fetch-assets.mjs --concurrency
  activePreset: 'default',
  customPresets: {},
};

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
  assetConcurrency: (v) => Math.min(64, Math.max(1, Number(v) || 16)),
  installDir: (v) => String(v || ''),
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
  return saveConfig(next);
}

/** Absolute install directory for the game. */
export const installDirOf = (cfg) => (cfg.installDir || DEFAULT_INSTALL_DIR);

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
