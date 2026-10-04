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
  loadConfig, patchConfig, allPresets, sourceById, SOURCES, ROOT, BUILTIN_PRESETS, installDirOf,
} from './lib/config.mjs';
import {
  inspectInstall, installFromSource, updateFromSource, npmCommand, gitCommand, gameDir, parseChangelog, gitInfo,
} from './lib/repo.mjs';
import { checkUpdate, localHistory } from './lib/version.mjs';
import {
  checkSelf as checkSelfUpdate, applySelf, selfHistory, selfVersion, selfRemote, selfBranch, isSelfRepo,
} from './lib/selfupdate.mjs';
import {
  exists, openExternal, openFolder, localAddresses, hasCommand, runCapture, fetchWithTimeout, nowIso, IS_WIN, IS_MAC, IS_LINUX,
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
      hasGit: hasCommand('git'),
      hasNpm: !!npmCommand(),
      hasTar: hasCommand('tar'),
      uptimeSec: Math.round(process.uptime()),
      now: nowIso(),
    },
    config,
    install: installInfo,
    server: game.state,
    task: taskRunner.state,
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

// ------------------------------------------------------------------------------------------------
// Task plans
// ------------------------------------------------------------------------------------------------

const nodeStep = (label, args, dir, extra = {}) => ({
  label, cmd: process.execPath, args, cwd: dir, ...extra,
});

function deploySteps(action) {
  const cfg = config;
  const dir = gameDir(cfg);
  const steps = [];
  const setupEnv = { SP_LAUNCHER: '1' };

  if (action === 'full') {
    steps.push({
      label: '下载 / 检出游戏源码',
      run: (ctx) => installFromSource(cfg, { log: (line, stream) => ctx.log(line, stream) }),
    });
    steps.push(nodeStep('安装依赖、前端库并下载素材（可中断续传）', [path.join('tools', 'setup.mjs'), '--quiet'], dir, { env: setupEnv }));
  } else if (action === 'repair') {
    steps.push(nodeStep('检查并补全依赖与素材（可中断续传）', [path.join('tools', 'setup.mjs'), '--quiet'], dir, { env: setupEnv }));
  } else if (action === 'deps') {
    const npm = npmCommand();
    if (npm) steps.push({ label: '安装 Node 依赖（npm install）', cmd: npm, args: ['install', '--no-audit', '--no-fund'], cwd: dir });
    steps.push(nodeStep('复制前端库到 public/vendor', [path.join('tools', 'vendor.mjs')], dir, { optional: !npm }));
  } else if (action === 'assets') {
    steps.push(nodeStep('下载美术 / 音频素材（约 250 MB，可续传）',
      [path.join('tools', 'fetch-assets.mjs'), `--concurrency=${cfg.assetConcurrency}`], dir));
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
  const labels = { full: '一键部署', repair: '修复安装', deps: '安装依赖', assets: '下载素材', doctor: '环境诊断' };
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
  const dir = gameDir(config);
  const steps = [
    { label: '获取最新版本', run: (ctx) => updateFromSource(config, { force, log: (line, stream) => ctx.log(line, stream) }) },
    nodeStep('同步依赖与素材', [path.join('tools', 'setup.mjs'), '--quiet'], dir, { env: { SP_LAUNCHER: '1' } }),
  ];
  const promise = taskRunner.run('update', force ? '强制更新' : '更新到最新版本', steps);
  promise.then(async (r) => {
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

  open(target) {
    const cfg = config;
    if (target === 'folder' || target === 'launcher-folder') {
      const dir = target === 'folder' ? gameDir(cfg) : ROOT;
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
