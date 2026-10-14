// launcher/index.mjs — entry point of the Stronghold Protocol server launcher.
//
//   node launcher/index.mjs [--port 7878] [--no-open] [--autostart]
//
// Starts a small local web UI (default http://127.0.0.1:7878) that downloads the game
// from a selectable source, installs its dependencies and art/audio assets, starts and
// monitors the server, and keeps it up to date. Closing the console (Ctrl+C) stops both
// the launcher and the game server it started.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHttpServer } from './lib/httpd.mjs';
import { EventBus, LogStore, CHANNELS } from './lib/events.mjs';
import { TaskRunner } from './lib/tasks.mjs';
import { GameServer, probePort } from './lib/game.mjs';
import {
  loadConfig, patchConfig, allPresets, sourceById, assetRouteOf, SOURCES, ROOT, BUILTIN_PRESETS, installDirOf,
  activeInstall, BRANCH,
} from './lib/config.mjs';
import {
  listInstalls, sharedStatus, installIdFor, installDirFor, cloneInstall, updateInstall, deleteInstall,
  linkInstallAssets, ensureShared, recordCommit, describeRepo, sharedPublicDir,
} from './lib/installs.mjs';
import {
  inspectInstall, installFromSource, updateFromSource, npmCommand, gitCommand, gameDir, parseChangelog, gitInfo,
  syncAssets, assetManifestHeld, localArtState, localExtractArgs,
} from './lib/repo.mjs';
import {
  modsStatus, fetchCatalog, applyMods, restoreGame, clearLock, validateSelection,
} from './lib/mods.mjs';
import { checkUpdate, localHistory } from './lib/version.mjs';
import {
  checkSelf as checkSelfUpdate, applySelf, selfHistory, selfVersion, selfRemote, selfBranch, isSelfRepo,
} from './lib/selfupdate.mjs';
import {
  exists, openExternal, openFolder, localAddresses, hasCommand, runCapture, fetchWithTimeout, nowIso, prependPath, gitInstallHint, IS_WIN, IS_MAC, IS_LINUX,
} from './lib/util.mjs';

const LAUNCHER_VERSION = selfVersion() || '1.0.0';
const DEFAULT_LAUNCHER_PORT = Number(process.env.SP_LAUNCHER_PORT) || 7878;

const argv = process.argv.slice(2);
const noOpen = argv.includes('--no-open') || /^(1|true|yes)$/i.test(process.env.SP_NO_BROWSER || '');
const argPort = (() => {
  const i = argv.findIndex((a) => a === '--port' || a.startsWith('--port='));
  if (i < 0) return null;
  const v = argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  return Number(v) || null;
})();

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`✘ Node.js ${process.versions.node} 太旧：启动器需要 Node.js 22 或更高（22 / 24 LTS）。`);
  console.error('  下载：https://nodejs.org/zh-cn/download');
  process.exit(1);
}

// ------------------------------------------------------------------------------------------------
// Core wiring
// ------------------------------------------------------------------------------------------------

let config = loadConfig();

/**
 * Adopt a pre-existing install into the version registry.
 *
 * Every launcher built before the registry pointed `installDir` at one folder. Rather than make those
 * users re-download, the folder becomes the first version: its git origin/branch are read back, and its
 * art is moved into the shared store so the next version does not fetch ~580 MB again.
 * @returns {{cfg:object, entry:(object|null)}} the migrated config and the version it adopted
 */
function migrateToInstalls(cfg) {
  if ((cfg.installs || []).length) return { cfg, entry: null };
  const dir = cfg.installDir;
  if (!dir || !exists(path.join(dir, 'package.json'))) return { cfg, entry: null };
  const { repo, ref } = describeRepo(dir);
  const id = `default--${((repo || 'local').replace(/\.git$/, '').split('/').pop() || 'local').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'local'}`;
  const entry = {
    id,
    label: repo ? `${repo.replace(/\.git$/, '').split('/').pop()}（已安装）` : '本地安装',
    kind: repo.includes('sganggs/Stronghold-Protocol') ? 'upstream' : 'fork',
    repo, ref: ref || 'master', dir, commit: recordCommit({ dir }), linkMode: '', addedAt: nowIso(),
  };
  return { cfg: patchConfig({ installs: [entry], activeInstallId: id }), entry };
}

const bus = new EventBus();
const logStore = new LogStore(4000);

const log = ({ channel = 'launcher', stream = 'stdout', line = '' }) => {
  const entry = logStore.push({ channel, stream, line });
  bus.emit({ type: 'log', entry });
};

const taskRunner = new TaskRunner({ log, onEvent: (evt) => bus.emit(evt) });
const game = new GameServer({
  log,
  getConfig: () => config,
  onEvent: (evt) => bus.emit(evt),
});

// Adopt a pre-registry install on first run, and move its art into the shared store.
if ((config.installs || []).length === 0 && config.installDir) {
  try {
    const { cfg, entry } = migrateToInstalls(config);
    if (entry) {
      config = cfg;
      log({ channel: 'launcher', stream: 'meta', line: `▶ 已把现有安装收纳为一个版本：${entry.label}` });
      const r = linkInstallAssets(config, entry.dir, { move: false, log: (line, stream) => log({ channel: 'launcher', stream: stream || 'stdout', line }) });
      if (r.mode === 'pending') log({ channel: 'launcher', stream: 'meta', line: '素材尚未接入共享区：到「版本」页点「重建素材链接」即可（会把已有素材收纳进共享区，不会重新下载）。' });
      if (r.shared || r.mode !== 'skipped') {
        const list = [...config.installs];
        list[list.indexOf(activeInstall(config))] = { ...entry, linkMode: r.mode };
        config = patchConfig({ installs: list });
      }
    }
  } catch (e) {
    log({ channel: 'launcher', stream: 'stderr', line: `收纳现有安装失败：${e?.message || e}` });
  }
}

let installInfo = inspectInstall(config);
let versionInfo = {
  checkedAt: null, installed: installInfo.hasPackageJson, installDir: installInfo.dir,
  local: { version: installInfo.packageVersion, git: null }, remote: null, updateAvailable: false, incoming: [], error: null,
};
let checkingVersion = false;

/** Local snapshot of the launcher's own repo, so the UI can render before any network check. */
function localSelfInfo() {
  return {
    checkedAt: null, dir: ROOT, branch: selfBranch(), remoteUrl: selfRemote(config),
    isRepo: isSelfRepo(), canUpdate: isSelfRepo(),
    local: { version: LAUNCHER_VERSION, git: isSelfRepo() ? gitInfo(ROOT) : null },
    remote: null, updateAvailable: false, relation: 'unknown', incoming: [], error: null,
  };
}
let selfInfo = { ...localSelfInfo() };
let selfUpdateReady = false;   // an update was applied and needs a launcher restart
let checkingSelf = false;

function refreshInstall() {
  installInfo = inspectInstall(config);
  return installInfo;
}

function buildState() {
  const hasGit = hasCommand('git');
  const sharingEnabled = config.shareAssets !== false;
  return {
    launcher: {
      version: LAUNCHER_VERSION,
      node: process.version,
      nodePath: process.execPath,
      platform: process.platform,
      platformLabel: IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : IS_LINUX ? 'Linux' : process.platform,
      arch: process.arch,
      root: ROOT,
      installDir: installDirOf(config),
      hasGit,
      gitInstall: hasGit ? null : gitInstallHint(),
      hasNpm: !!npmCommand(),
      hasTar: hasCommand('tar'),
      uptimeSec: Math.round(process.uptime()),
      now: nowIso(),
    },
    config,
    install: installInfo,
    server: game.state,
    task: taskRunner.state,
    installs: listInstalls(config),
    activeInstallId: config.activeInstallId || null,
    shared: sharingEnabled ? sharedStatus(config) : { ...sharedStatus(config), disabled: true },
    version: versionInfo,
    checkingVersion,
    self: { ...selfInfo, updateReady: selfUpdateReady, checking: checkingSelf },
    network: { addresses: localAddresses(), share: game.shareUrls() },
    presets: allPresets(config),
    sources: SOURCES,
    channels: CHANNELS,
  };
}

const emitState = () => bus.emit({ type: 'state', state: buildState() });
const toast = (message, level = 'info') => bus.emit({ type: 'toast', message, level });

/** A version id that is free in the registry (a second copy of the same repo/ref gets a suffix). */
function uniqueInstallId(cfg, base) {
  const taken = new Set((cfg.installs || []).map((e) => e.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

// ------------------------------------------------------------------------------------------------
// Task plans
// ------------------------------------------------------------------------------------------------

const nodeStep = (label, args, dir, extra = {}) => ({
  label, cmd: process.execPath, args, cwd: dir, ...extra,
  env: prependPath(path.dirname(process.execPath), { ...process.env, ...extra.env }),
});

/**
 * The environment for the steps that run the game's tools/setup.mjs: it drives the asset tool itself,
 * so hand it the route the chosen download source implies (config.mjs `assetRouteOf`) — otherwise a
 * user who picked an accelerated source still downloads the ~250 MB of art straight from GitHub.
 */
function setupEnv() {
  const route = assetRouteOf(config);
  return {
    SP_LAUNCHER: '1',
    SP_ASSET_SOURCE: route.source,
    ...(route.proxy ? { SP_GITHUB_PROXY: route.proxy } : {}),
  };
}

/**
 * `tools/setup.mjs` arguments for the routine deploy / update paths: quiet, plus the client-art flags
 * derived from the config (see repo.mjs `localExtractArgs` — the artwork lives in the install, so its
 * presence decides between "report it" and "extract it").
 */
function setupArgs() {
  const dir = gameDir(config);
  return [path.join('tools', 'setup.mjs'), '--quiet', ...localExtractArgs(config, localArtState(dir).manifest)];
}

/**
 * Sync art / audio through the game's tool, which heals a stale upstream index and a blocked direct
 * GitHub connection by itself (repo.mjs `syncAssets`). `strict` is the explicit 「下载素材」action,
 * which must report a failure it cannot finish; without it (deploy / update flows) a remaining gap is
 * only a warning — like the game's own tools/setup.mjs, the game still runs with placeholder art.
 */
async function runAssetSync(ctx, { strict }) {
  const r = await syncAssets(config, {
    log: (line, stream) => ctx.log(line, stream),
    trackChild: ctx.trackChild,
    isCancelled: ctx.isCancelled,
  });
  if (r.ok) return;
  const via = [r.refreshed && '已刷新上游索引', r.mirrored && '已改用 GitHub 镜像'].filter(Boolean).join('、');
  const tail = `${r.code}${via ? `，${via}` : ''}`;
  if (strict) throw new Error(`素材仍未下载完整（退出码 ${tail}），可稍后重试（支持续传）`);
  ctx.log(`素材仍未下载完整（退出码 ${tail}）；游戏仍可运行（使用占位图），可稍后点「下载素材」续传。`, 'meta');
}

/**
 * Step after the game's tools/setup.mjs: when its asset download was stopped by the manifest shrink
 * guard (a `.cache/` upstream index older than the operators the update added, so the committed
 * data/assets.json was kept), sync again with refreshed indexes. A completed run does nothing here.
 */
const assetHealStep = (dir) => ({
  label: '补全美术 / 音频素材（必要时刷新上游索引）',
  run: async (ctx) => {
    if (!assetManifestHeld(dir)) return;
    ctx.log('上次素材同步保留了仓库里的 data/assets.json（上游索引可能已过期），重新同步…', 'meta');
    await runAssetSync(ctx, { strict: false });
  },
});

/**
 * Make sure the active version's folder holds the sources, then wire its art to the shared store.
 *
 * Everything the launcher runs is one of these folders. New users start with none: the first deploy
 * registers an upstream version from the chosen download source, so from then on the registry is the
 * single source of truth. Users without git fall back to the archive route (repo.mjs).
 */
function ensureSources(ctx) {
  const cfg = config;
  let entry = activeInstall(cfg);
  if (!entry) {
    const src = sourceById(cfg.downloadSource);
    const id = installIdFor(src.git, BRANCH);
    entry = {
      id, label: `原版 ${BRANCH}`, kind: 'upstream', repo: src.git, ref: BRANCH,
      dir: installDirFor(id), commit: '', linkMode: '', addedAt: nowIso(),
    };
    config = patchConfig({ installs: [...(cfg.installs || []), entry], activeInstallId: id, installDir: entry.dir });
    ctx.log(`▶ 已登记原版版本：${entry.label}`, 'meta');
  }
  const dir = entry.dir;
  if (exists(path.join(dir, 'package.json'))) {
    ctx.log(`目录已存在，跳过下载：${dir}`, 'meta');
  } else if (gitCommand() && entry.repo) {
    cloneInstall(dir, entry.repo, entry.ref, { log: (line, stream) => ctx.log(line, stream) });
  } else {
    // No git (or no recorded origin): the archive route downloads a tarball instead.
    ctx.log('未使用 git 或没有来源仓库，改用压缩包下载…', 'meta');
    return installFromSource(cfg, { log: (line, stream) => ctx.log(line, stream) });
  }
  const list = (config.installs || []).map((e) => (e.id === entry.id ? { ...e, commit: recordCommit({ dir }) } : e));
  config = patchConfig({ installs: list });
  return { adopted: false, dir };
}

/** A step that points the active version's `public/assets` + `public/fonts` at the shared store. */
const linkStep = () => ({
  label: '把素材目录接入共享区（可关闭）',
  run: (ctx) => {
    const entry = activeInstall(config);
    if (!entry) { ctx.log('还没有版本，跳过。', 'meta'); return; }
    if (config.shareAssets === false) { ctx.log('素材共享已关闭（配置里可开启）：该版本会自行下载素材。', 'meta'); return; }
    const r = linkInstallAssets(config, entry.dir, { log: (line, stream) => ctx.log(line, stream) });
    if (r.mode !== 'skipped') {
      config = patchConfig({ installs: (config.installs || []).map((e) => (e.id === entry.id ? { ...e, linkMode: r.mode } : e)) });
      ctx.log(`素材目录已接入共享区（方式：${r.mode}）`, 'meta');
    }
  },
});

function deploySteps(action) {
  const cfg = config;
  const dir = gameDir(cfg);
  const steps = [];

  if (action === 'full') {
    steps.push({
      label: '下载 / 检出游戏源码',
      run: (ctx) => ensureSources(ctx),
    });
    steps.push(linkStep());
    steps.push(nodeStep('安装依赖、前端库并下载素材（可中断续传）', setupArgs(), dir, { env: setupEnv() }));
    steps.push(assetHealStep(dir));
  } else if (action === 'repair') {
    steps.push(linkStep());
    steps.push(nodeStep('检查并补全依赖与素材（可中断续传）', setupArgs(), dir, { env: setupEnv() }));
    steps.push(assetHealStep(dir));
  } else if (action === 'link') {
    steps.push(linkStep());
  } else if (action === 'local') {
    // Re-extract the official client art (docs/DEPLOY.md §6): force it, so a stale extraction made by
    // an older extract.py can be refreshed. `--game` when the user pinned the client path.
    const args = ['--local', ...(cfg.clientDir ? ['--game', cfg.clientDir] : [])];
    steps.push(nodeStep('从本地客户端提取官方素材', [path.join('tools', 'setup.mjs'), '--quiet', ...args], dir, { env: setupEnv() }));
  } else if (action === 'client') {
    // Detection only: setup.mjs prints which client it found (and whether it has the autochess
    // resources) without writing anything. `--check` skips every other step's writes too.
    const args = ['--check', ...(cfg.clientDir ? ['--game', cfg.clientDir] : [])];
    steps.push(nodeStep('检测本机明日方舟客户端', [path.join('tools', 'setup.mjs'), ...args], dir, { env: setupEnv(), optional: true }));
  } else if (action === 'deps') {
    const npm = npmCommand();
    if (npm) steps.push({ label: '安装 Node 依赖（npm install）', cmd: npm, args: ['install', '--no-audit', '--no-fund'], cwd: dir });
    steps.push(nodeStep('复制前端库到 public/vendor', [path.join('tools', 'vendor.mjs')], dir, { optional: !npm }));
  } else if (action === 'assets') {
    steps.push({
      label: '下载美术 / 音频素材（约 250 MB，可续传）',
      run: (ctx) => runAssetSync(ctx, { strict: true }),
    });
  } else if (action === 'doctor') {
    steps.push(nodeStep('运行环境诊断', [path.join('tools', 'doctor.mjs')], dir, { optional: true }));
  } else {
    throw new Error(`未知的部署动作：${action}`);
  }
  return steps;
}

async function runDeploy(action) {
  if (!exists(path.join(gameDir(config), 'package.json')) && action !== 'full') {
    return { started: false, error: '尚未部署游戏，请先执行「一键部署」。' };
  }
  if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
  const labels = { full: '一键部署', repair: '修复安装', deps: '安装依赖', assets: '下载素材', local: '提取本地客户端素材', client: '检测客户端', doctor: '环境诊断' };
  const promise = taskRunner.run(action === 'doctor' ? 'launcher' : 'deploy', labels[action] || action, deploySteps(action));
  promise.then((r) => {
    refreshInstall();
    emitState();
    toast(r.ok ? `${labels[action] || action} 完成` : `${labels[action] || action} 失败`, r.ok ? 'ok' : 'error');
  });
  return { started: true };
}

async function runUpdate(force) {
  if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
  if (!exists(path.join(gameDir(config), 'package.json'))) return { started: false, error: '尚未部署游戏，请先执行「一键部署」。' };
  // A modded install has a dirty working tree, so a fast-forward update cannot apply (and would
  // silently discard the mods). Say so instead of letting git refuse with a cryptic message.
  if (modsStatus(config).applied) {
    return {
      started: false,
      error: '当前安装启用了模组：请先在「模组」页点「还原为原版」再更新（更新会覆盖模组改动），或勾选「强制更新」丢弃它们。',
    };
  }
  const dir = gameDir(config);
  const steps = [
    { label: '获取最新版本', run: (ctx) => updateFromSource(config, { force, log: (line, stream) => ctx.log(line, stream) }) },
    nodeStep('同步依赖与素材', setupArgs(), dir, { env: setupEnv() }),
    assetHealStep(dir),
  ];
  const promise = taskRunner.run('update', force ? '强制更新' : '更新到最新版本', steps);
  promise.then(async (r) => {
    // A forced update resets the tree to the fetched master, so any mod is gone: drop the stale lock.
    if (r.ok && force) clearLock();
    refreshInstall();
    if (r.ok) versionInfo = await checkUpdate(config, { deep: false });
    emitState();
    toast(r.ok ? '更新完成' : '更新失败', r.ok ? 'ok' : 'error');
  });
  return { started: true };
}

// ------------------------------------------------------------------------------------------------
// Actions exposed to the UI
// ------------------------------------------------------------------------------------------------

const actions = {
  saveConfig(patch) {
    const before = config.installDir;
    config = patchConfig(patch);
    if (config.installDir !== before) refreshInstall();
    emitState();
    return config;
  },

  applyPreset(body = {}) {
    if (body.delete) {
      const custom = { ...config.customPresets };
      delete custom[body.delete];
      config = patchConfig({ customPresets: custom });
      emitState();
      return { ok: true, config };
    }
    if (body.save) {
      const name = String(body.save).trim().slice(0, 40) || '自定义预设';
      const id = `custom-${Date.now().toString(36)}`;
      const values = { port: config.port, host: config.host, combat: config.combat, verify: config.verify, trustProxy: config.trustProxy, debug: config.debug };
      config = patchConfig({ customPresets: { ...config.customPresets, [id]: { label: name, desc: body.desc || '自定义预设', values } }, activePreset: id });
      emitState();
      return { ok: true, config };
    }
    const preset = allPresets(config).find((p) => p.id === body.id) || BUILTIN_PRESETS[0];
    config = patchConfig({ ...preset.values, activePreset: preset.id });
    emitState();
    return { ok: true, config, applied: preset.id };
  },

  async testSources(ids) {
    const list = Array.isArray(ids) && ids.length ? SOURCES.filter((s) => ids.includes(s.id)) : SOURCES;
    const git = gitCommand();
    log({ channel: 'launcher', stream: 'meta', line: `▶ 测试 ${list.length} 个下载源的连通性…` });
    const results = await Promise.all(list.map(async (s) => {
      const t0 = Date.now();
      if (git) {
        const r = runCapture(git, ['ls-remote', s.git, 'refs/heads/master'], { timeout: 20000 });
        const ok = r.ok && /\w/.test(r.out);
        return { id: s.id, label: s.label, ok, ms: Date.now() - t0, detail: ok ? `master ${r.out.split(/\s+/)[0].slice(0, 8)}` : (r.out.split('\n')[0] || '连接失败').slice(0, 140) };
      }
      try {
        const res = await fetchWithTimeout(s.archive, { method: 'HEAD', timeout: 20000 });
        return { id: s.id, label: s.label, ok: res.ok, ms: Date.now() - t0, detail: `HTTP ${res.status}` };
      } catch (e) {
        return { id: s.id, label: s.label, ok: false, ms: Date.now() - t0, detail: String(e?.message || e).slice(0, 140) };
      }
    }));
    for (const r of results) log({ channel: 'launcher', stream: r.ok ? 'stdout' : 'stderr', line: `${r.ok ? '✔' : '✘'} ${r.label} — ${r.ms} ms${r.detail ? ` · ${r.detail}` : ''}` });
    return { results };
  },

  // ---------------------------------------------------------------- mods (lib/mods.mjs)
  async modsRefresh() {
    log({ channel: 'mods', stream: 'meta', line: `▶ 获取模组目录（${config.modsRepoUrl || '未配置'}）…` });
    try {
      const catalog = await fetchCatalog(config, { log: (line, stream) => log({ channel: 'mods', stream: stream || 'stdout', line }) });
      // Drop a selection whose entry left the catalog, so the checkbox state can never point at nothing.
      const ids = new Set(catalog.mods.map((m) => m.id));
      const kept = (config.enabledMods || []).filter((id) => ids.has(id));
      if (kept.length !== (config.enabledMods || []).length) config = patchConfig({ enabledMods: kept });
      emitState();
      return { ok: true, count: catalog.mods.length, base: catalog.base, fetchedAt: catalog.fetchedAt };
    } catch (e) {
      log({ channel: 'mods', stream: 'stderr', line: `获取模组目录失败：${e?.message || e}` });
      return { ok: false, error: String(e?.message || e) };
    }
  },

  modsSelect(ids) {
    config = patchConfig({ enabledMods: Array.isArray(ids) ? ids : [] });
    emitState();
    return { ok: true, config };
  },

  modsApply(body) {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    const ids = Array.isArray(body?.ids) && body.ids.length ? body.ids : (config.enabledMods || []);
    if (!ids.length) return { started: false, error: '请先勾选要启用的模组。' };
    if (!exists(path.join(gameDir(config), 'package.json'))) return { started: false, error: '尚未部署游戏，请先「一键部署」。' };
    // `allowBaseMismatch` comes from the UI after it warned the user that the install is not at the
    // catalog's pinned base; without it the engine refuses (lib/mods.mjs checkBase).
    const allowBaseMismatch = body?.allowBaseMismatch === true;
    // Refuse a bad combination before a task starts, so the UI can say why right away.
    const valid = validateSelection(config, ids);
    if (!valid.ok) return { started: false, error: valid.error };
    config = patchConfig({ enabledMods: ids });
    const promise = taskRunner.run('mods', allowBaseMismatch ? '应用模组（忽略版本不一致）' : '应用模组', [
      { label: `应用 ${ids.length} 个模组`, run: (ctx) => applyMods(config, ids, { log: (line, stream) => ctx.log(line, stream), allowBaseMismatch }) },
    ]);
    promise.then((r) => {
      refreshInstall();
      emitState();
      toast(r.ok ? '模组已应用 —— 重启服务器后生效' : '模组应用失败，可在「终端」查看原因', r.ok ? 'ok' : 'error', 8000);
    });
    return { started: true };
  },

  modsRestore() {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    if (!exists(path.join(gameDir(config), 'package.json'))) return { started: false, error: '尚未部署游戏。' };
    config = patchConfig({ enabledMods: [] });
    const promise = taskRunner.run('mods', '还原为原版', [
      { label: '还原为原版（清除所有模组）', run: (ctx) => restoreGame(config, { log: (line, stream) => ctx.log(line, stream) }) },
    ]);
    promise.then((r) => {
      refreshInstall();
      emitState();
      toast(r.ok ? '已还原为原版（重启服务器后生效）' : '还原失败', r.ok ? 'ok' : 'error', 8000);
    });
    return { started: true };
  },

  // ---------------------------------------------------------------- versions (lib/installs.mjs)
  /**
   * Register a version and install it. `body = { repo, ref, label }` — a GitHub URL plus branch/tag;
   * empty `repo` means "upstream from the chosen download source".
   */
  installsAdd(body = {}) {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    const src = sourceById(config.downloadSource);
    const repo = String(body.repo || '').trim() || src.git;
    const ref = String(body.ref || '').trim() || BRANCH;
    if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(repo) && !path.isAbsolute(repo)) {
      return { started: false, error: '仓库地址需要是 https:// / git@ / ssh:// 地址，或本机上的绝对路径。' };
    }
    const id = uniqueInstallId(config, installIdFor(repo, ref));
    const entry = {
      id,
      label: String(body.label || '').trim().slice(0, 80) || `${repo.replace(/\.git$/, '').split('/').pop()}（${ref}）`,
      kind: /sganggs\/Stronghold-Protocol/.test(repo) ? 'upstream' : 'fork',
      repo, ref,
      dir: installDirFor(id),
      commit: '', linkMode: '', addedAt: nowIso(),
    };
    if (exists(path.join(entry.dir, 'package.json'))) return { started: false, error: `这个版本已经在列表里了（目录已存在）：${entry.dir}` };
    config = patchConfig({ installs: [...(config.installs || []), entry], activeInstallId: id, installDir: entry.dir });
    log({ channel: 'deploy', stream: 'meta', line: `▶ 新版本：${entry.label}（${repo} @ ${ref}）` });
    const promise = taskRunner.run('deploy', `安装版本：${entry.label}`, deploySteps('full'));
    promise.then((r) => {
      refreshInstall();
      emitState();
      toast(r.ok ? `版本「${entry.label}」已安装` : '安装失败，可在「终端」查看原因', r.ok ? 'ok' : 'error', 8000);
    });
    return { started: true, id };
  },

  /** Adopt an existing folder on disk as a version (for a fork the user already cloned). */
  installsAdopt(body = {}) {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    const dir = String(body.dir || '').trim();
    if (!dir || !path.isAbsolute(dir)) return { started: false, error: '请填写一个绝对路径。' };
    if (!exists(path.join(dir, 'package.json'))) return { started: false, error: `这个目录里没有 package.json：${dir}` };
    if ((config.installs || []).some((e) => e.dir === dir)) return { started: false, error: '这个目录已经在版本列表里了。' };
    const { repo, ref } = describeRepo(dir);
    const id = uniqueInstallId(config, installIdFor(repo || dir, ref || 'local'));
    const entry = {
      id,
      label: String(body.label || '').trim().slice(0, 80) || path.basename(dir),
      kind: repo && !/sganggs\/Stronghold-Protocol/.test(repo) ? 'fork' : (repo ? 'upstream' : 'fork'),
      repo, ref: ref || '', dir, commit: recordCommit({ dir }), linkMode: '', addedAt: nowIso(),
    };
    config = patchConfig({ installs: [...(config.installs || []), entry], activeInstallId: id, installDir: dir });
    const r = linkInstallAssets(config, dir, { log: (line, stream) => log({ channel: 'deploy', stream: stream || 'stdout', line }) });
    config = patchConfig({ installs: (config.installs || []).map((e) => (e.id === id ? { ...e, linkMode: r.mode } : e)) });
    refreshInstall();
    emitState();
    toast(`已收纳版本「${entry.label}」${r.shared ? '（素材已接入共享区）' : ''}`, 'ok', 8000);
    return { ok: true, id };
  },

  installsActivate(body = {}) {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    const entry = (config.installs || []).find((e) => e.id === body.id);
    if (!entry) return { started: false, error: '找不到这个版本。' };
    const running = game.running;
    if (running) return { started: false, error: '服务器正在运行：请先「停止服务器」，再切换版本（切换会重启进程）。' };
    config = patchConfig({ activeInstallId: entry.id, installDir: entry.dir });
    refreshInstall();
    emitState();
    toast(`已切换到「${entry.label}」——点「启动服务器」生效`, 'ok', 6000);
    return { ok: true, activeInstallId: entry.id };
  },

  installsRemove(body = {}) {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    const entry = (config.installs || []).find((e) => e.id === body.id);
    if (!entry) return { started: false, error: '找不到这个版本。' };
    if (game.running && config.activeInstallId === entry.id) return { started: false, error: '这个版本正在运行：请先「停止服务器」。' };
    const promise = taskRunner.run('deploy', `删除版本：${entry.label}`, [{
      label: `删除版本目录（不动共享素材）`,
      run: (ctx) => { deleteInstall(entry, { log: (line, stream) => ctx.log(line, stream) }); },
    }]);
    promise.then(() => {
      const rest = (config.installs || []).filter((e) => e.id !== entry.id);
      const active = config.activeInstallId === entry.id ? (rest[0]?.id || '') : config.activeInstallId;
      config = patchConfig({ installs: rest, activeInstallId: active, installDir: rest.find((e) => e.id === active)?.dir || '' });
      refreshInstall();
      emitState();
      toast(`已删除版本「${entry.label}」`, 'ok', 6000);
    });
    return { started: true };
  },

  installsUpdate(body = {}) {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    const entry = (config.installs || []).find((e) => e.id === body.id);
    if (!entry) return { started: false, error: '找不到这个版本。' };
    if (game.running && config.activeInstallId === entry.id) return { started: false, error: '这个版本正在运行：请先「停止服务器」再更新。' };
    const force = body.force === true;
    const dir = entry.dir;
    const steps = [
      { label: force ? '更新版本（丢弃该版本的本地改动）' : '更新版本', run: (ctx) => {
        const r = updateInstall(config, entry, { force, log: (line, stream) => ctx.log(line, stream) });
        config = patchConfig({ installs: (config.installs || []).map((e) => (e.id === entry.id ? { ...e, commit: r.commit } : e)) });
      } },
      nodeStep('同步依赖与素材', setupArgs(), dir, { env: setupEnv() }),
      assetHealStep(dir),
    ];
    const promise = taskRunner.run('update', `更新版本：${entry.label}`, steps);
    promise.then((r) => {
      refreshInstall();
      emitState();
      toast(r.ok ? `版本「${entry.label}」已更新` : '更新失败，可在「终端」查看原因', r.ok ? 'ok' : 'error', 8000);
    });
    return { started: true };
  },

  /** Force the art link for every version (after toggling sharing, or after moving the shared folder). */
  installsRelink() {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    if (config.shareAssets === false) return { started: false, error: '素材共享已关闭（先在「配置」里开启）。' };
    if (game.running) return { started: false, error: '服务器正在运行：请先停止，再重建素材链接。' };
    const list = [];
    for (const entry of config.installs || []) {
      if (!exists(path.join(entry.dir, 'package.json'))) continue;
      const r = linkInstallAssets(config, entry.dir, { move: true, log: (line, stream) => log({ channel: 'deploy', stream: stream || 'stdout', line }) });
      list.push({ ...entry, linkMode: r.mode });
    }
    config = patchConfig({ installs: list.length ? list : config.installs });
    ensureShared(config);
    refreshInstall();
    emitState();
    toast(`已重建 ${list.length} 个版本的素材链接`, 'ok', 6000);
    return { ok: true, count: list.length };
  },

  deploy: runDeploy,
  update: runUpdate,
  cancelTask: () => taskRunner.cancel(),

  async checkVersion(deep = false) {
    if (checkingVersion) return { checking: true, version: versionInfo };
    if (!exists(path.join(gameDir(config), 'package.json'))) {
      versionInfo = { ...versionInfo, checkedAt: nowIso(), installed: false, error: null, updateAvailable: false };
      emitState();
      return { version: versionInfo };
    }
    checkingVersion = true;
    emitState();
    log({ channel: 'update', stream: 'meta', line: `▶ 检查更新（源：${sourceById(config.downloadSource).label}）…` });
    try {
      versionInfo = await checkUpdate(config, { deep, log: (line) => log({ channel: 'update', stream: 'stdout', line }) });
      const lv = versionInfo.local?.version ?? '?';
      const rv = versionInfo.remote?.version ?? '?';
      if (versionInfo.error) log({ channel: 'update', stream: 'stderr', line: `检查失败：${versionInfo.error}` });
      else if (versionInfo.updateAvailable) log({ channel: 'update', stream: 'stdout', line: `发现新版本：本地 ${lv} → 远程 ${rv}` });
      else log({ channel: 'update', stream: 'stdout', line: `已是最新版本（${lv}）` });
    } catch (e) {
      versionInfo = { ...versionInfo, checkedAt: nowIso(), error: String(e?.message || e) };
      log({ channel: 'update', stream: 'stderr', line: `检查失败：${versionInfo.error}` });
    } finally {
      checkingVersion = false;
      emitState();
    }
    return { version: versionInfo };
  },

  getHistory() {
    const history = exists(path.join(gameDir(config), 'package.json'))
      ? localHistory(config)
      : { changelog: [], commits: [] };
    return {
      ...history,
      version: versionInfo,
      remoteChangelog: versionInfo.remoteChangelog || [],
      self: selfHistory(),
    };
  },

  getChangelog() {
    const dir = gameDir(config);
    return exists(path.join(dir, 'CHANGELOG.md')) ? parseChangelog(dir) : [];
  },

  // ---------------------------------------------------------------- launcher self-update
  async checkSelf(deep = false) {
    if (checkingSelf) return { checking: true, self: selfInfo };
    checkingSelf = true;
    emitState();
    log({ channel: 'update', stream: 'meta', line: `▶ 检查启动器更新（${selfRemote(config) || '未配置仓库'}）…` });
    try {
      selfInfo = await checkSelfUpdate(config, { deep, log: (line) => log({ channel: 'update', stream: 'stdout', line }) });
      if (selfInfo.error) log({ channel: 'update', stream: 'stderr', line: `启动器更新检查失败：${selfInfo.error}` });
      else if (selfInfo.updateAvailable) log({ channel: 'update', stream: 'stdout', line: `启动器有新版本：${selfInfo.local.version} → ${selfInfo.remote?.version ?? '?'}` });
      else log({ channel: 'update', stream: 'stdout', line: `启动器已是最新（${selfInfo.local.version}）` });
    } catch (e) {
      selfInfo = { ...selfInfo, checkedAt: nowIso(), error: String(e?.message || e) };
      log({ channel: 'update', stream: 'stderr', line: `启动器更新检查失败：${selfInfo.error}` });
    } finally {
      checkingSelf = false;
      emitState();
    }
    return { self: selfInfo };
  },

  async updateSelf(force = false) {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    if (!isSelfRepo()) return { started: false, error: '启动器目录不是 git 仓库，无法自动更新。' };
    const before = { version: selfVersion(), commit: gitInfo(ROOT)?.commit ?? null };
    const steps = [{
      label: force ? '强制更新启动器（丢弃本地修改）' : '更新启动器',
      run: (ctx) => applySelf(config, { force, log: (line, stream) => ctx.log(line, stream) }),
    }];
    const promise = taskRunner.run('update', force ? '强制更新启动器' : '更新启动器', steps);
    promise.then(async (r) => {
      const after = { version: selfVersion(), commit: gitInfo(ROOT)?.commit ?? null };
      const changed = before.commit !== after.commit || before.version !== after.version;
      if (r.ok && changed) {
        selfUpdateReady = true;
        selfInfo = await checkSelfUpdate(config, { deep: false });
        toast('启动器已更新，重启后生效', 'ok', 8000);
      } else if (r.ok) {
        selfInfo = await checkSelfUpdate(config, { deep: false });
        toast('启动器已是最新，无需重启', 'ok', 5000);
      } else {
        toast('启动器更新失败', 'error', 8000);
      }
      emitState();
    });
    return { started: true };
  },

  restartSelf() {
    if (taskRunner.busy) return { ok: false, error: '有任务正在运行，请稍后再试。' };
    log({ channel: 'launcher', stream: 'meta', line: '正在重启启动器…' });
    setTimeout(() => relaunchAndExit(), 300);
    return { ok: true };
  },

  async serverStart() { const r = await game.start(); emitState(); return r; },
  async serverStop() { const r = await game.stop(); emitState(); return r; },
  async serverRestart() {
    const r = await game.restart();
    emitState();
    return r;
  },

  open(target, id) {
    const cfg = config;
    if (target === 'install') {
      const entry = (cfg.installs || []).find((e) => e.id === id) || activeInstall(cfg);
      if (!entry) return { ok: false, error: '找不到这个版本。' };
      const ok = openFolder(entry.dir);
      return ok ? { ok: true, path: entry.dir } : { ok: false, error: `无法打开目录（不存在或被系统拒绝）：${entry.dir}` };
    }
    if (target === 'folder' || target === 'launcher-folder') {
      const dir = target === 'folder' ? gameDir(cfg) : ROOT;
      const ok = openFolder(dir);
      return ok ? { ok: true, path: dir } : { ok: false, error: `无法打开目录（不存在或被系统拒绝）：${dir}` };
    }
    if (target === 'shared') {
      const dir = sharedPublicDir(cfg);
      const ok = openFolder(dir);
      return ok ? { ok: true, path: dir } : { ok: false, error: `无法打开目录（不存在或被系统拒绝）：${dir}` };
    }
    if (target === 'game') { openExternal(`http://localhost:${cfg.port}`); return { ok: true, url: `http://localhost:${cfg.port}` }; }
    if (target === 'repo') { openExternal('https://github.com/sganggs/Stronghold-Protocol'); return { ok: true }; }
    if (target === 'releases') { openExternal('https://github.com/sganggs/Stronghold-Protocol/releases'); return { ok: true }; }
    if (target === 'issues') { openExternal('https://github.com/sganggs/Stronghold-Protocol/issues'); return { ok: true }; }
    return { ok: false, error: `未知目标：${target}` };
  },

  async refresh() {
    refreshInstall();
    await game.refreshHealth();
    emitState();
    return { ok: true, install: installInfo };
  },

  quit() {
    log({ channel: 'launcher', stream: 'meta', line: '正在退出启动器…' });
    shutdown(0);
  },
};

// ------------------------------------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------------------------------------

async function pickPort(start) {
  for (let p = start; p < start + 40; p++) {
    if (!(await probePort(p))) return p;
  }
  return start;
}

function printBanner(url) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log('  卫戍协议：盟约 · Stronghold Protocol — 服务器启动器');
  console.log(`${line}`);
  console.log(`  控制面板：${url}`);
  console.log(`  安装目录：${installDirOf(config)}`);
  console.log(`  下载源：  ${sourceById(config.downloadSource).label}`);
  console.log(`  浏览器未自动打开？请手动访问上面的地址。`);
  console.log(`  按 Ctrl+C 退出启动器（同时会停止它启动的游戏服务器）。`);
  if (!hasCommand('git')) {
    console.log(`  ⚠ 未检测到 git：游戏仍可用压缩包方式部署，但启动器无法自动更新。`);
    console.log(`    安装 git 后即可开启启动器自更新：https://git-scm.com/downloads`);
  }
  console.log(`${line}\n`);
}

let httpServer = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { game.dispose(); } catch { /* ignore */ }
  try { httpServer?.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 400);
}

/**
 * Restart the launcher in place (used after a self-update).
 *
 * The child replaces this process for the user, but we *stay alive and wait* for it: on Windows
 * the launcher usually runs inside the console created by 启动器.bat, and exiting immediately
 * would close that console and take the freshly started child down with it.
 */
async function relaunchAndExit() {
  if (process.env.SP_SELF_RELAUNCHED === '1') return;
  try { game.dispose(); } catch { /* ignore */ }      // stop the game server before handing over
  try { httpServer?.close(); } catch { /* ignore */ }
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, SP_SELF_RELAUNCHED: '1' },
  });
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('exit', (c) => resolve(c ?? 0));
  });
  process.exit(code);
}

/**
 * Update the launcher from its own repository before the control panel exists.
 * Safe by construction: nothing is running yet, and a failure (offline, no upstream access,
 * local modifications) only logs and continues with the current version.
 */
async function selfUpdateAtStartup() {
  if (!config.autoUpdateSelf || !isSelfRepo()) return;
  if (process.env.SP_SELF_RELAUNCHED === '1') return;   // already updated + restarted once
  const t0 = Date.now();
  process.stdout.write('  正在检查启动器更新…');
  try {
    const info = await checkSelfUpdate(config, { quick: true, log: (line) => log({ channel: 'update', stream: 'stdout', line }) });
    selfInfo = info;
    if (info.error) {
      console.log(`\r  启动器自更新已跳过：${info.error}`);
      log({ channel: 'update', stream: 'stdout', line: `启动器自更新已跳过：${info.error}` });
      return;
    }
    if (!info.updateAvailable) {
      console.log(`\r  启动器已是最新（v${info.local.version}，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      log({ channel: 'update', stream: 'stdout', line: `启动器已是最新（v${info.local.version}）` });
      return;
    }
    console.log(`\r  发现启动器新版本，正在自动更新…`);
    log({ channel: 'update', stream: 'meta', line: `▶ 启动器有新版本（${info.local.git?.short ?? info.local.version} → ${info.remote?.commit?.slice(0, 7) ?? '?'}），正在自动更新…` });
    const before = gitInfo(ROOT)?.commit ?? null;
    const r = await applySelf(config, { force: false, log: (line) => log({ channel: 'update', stream: 'stdout', line }) });
    if ((gitInfo(ROOT)?.commit ?? null) === before) {
      // The remote commit was already in our history (local ahead) — nothing was pulled, so a
      // restart would be pointless (and would repeat on every launch).
      console.log('\r  启动器已是最新，无需重启');
      log({ channel: 'update', stream: 'stdout', line: '启动器已经包含最新提交，跳过重启。' });
      return;
    }
    log({ channel: 'update', stream: 'meta', line: `✔ 启动器已更新到 v${r.version}，正在重启…` });
    console.log('  启动器已自动更新，正在重启…\n');
    await relaunchAndExit();
  } catch (e) {
    console.log(`\r  启动器自更新已跳过：${e?.message || e}`);
    log({ channel: 'update', stream: 'stdout', line: `启动器自更新已跳过：${e?.message || e}` });
  }
}

async function main() {
  await selfUpdateAtStartup();   // may relaunch the process; must run before anything listens

  const port = await pickPort(argPort || DEFAULT_LAUNCHER_PORT);
  const url = `http://127.0.0.1:${port}/`;
  httpServer = createHttpServer({ getState: buildState, actions, logStore, bus });
  await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  log({ channel: 'launcher', stream: 'meta', line: `启动器 v${LAUNCHER_VERSION} 已就绪（Node ${process.version}，${process.platform}）` });
  printBanner(url);

  if (!noOpen) openExternal(url);

  // Keep the health badge fresh while the server is running.
  setInterval(() => { if (game.running) game.refreshHealth().then(emitState); }, 5000);

  if (config.autoStart && installInfo.hasPackageJson) {
    log({ channel: 'launcher', stream: 'meta', line: '按配置自动启动服务器…' });
    game.start().then(emitState);
  }

  if (config.autoUpdateCheck && installInfo.hasPackageJson) {
    setTimeout(() => { actions.checkVersion(false); }, 800);
  }

  process.on('SIGINT', () => { console.log('\n收到 Ctrl+C，正在退出…'); shutdown(0); });
  process.on('SIGTERM', () => shutdown(0));
}

main().catch((e) => {
  console.error('启动器启动失败：', e?.stack || e);
  process.exit(1);
});
