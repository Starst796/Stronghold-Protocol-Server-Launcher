// launcher/index.mjs — entry point of the Stronghold Protocol server launcher.
//
//   node launcher/index.mjs [--port 7878] [--no-open] [--autostart]
//
// Starts a small local web UI (default http://127.0.0.1:7878) that downloads the game
// from a selectable source, installs its dependencies and art/audio assets, starts and
// monitors the server, and keeps it up to date. Closing the console (Ctrl+C) stops both
// the launcher and the game server it started.

import fs from 'node:fs';
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
  linkInstallAssets, ensureShared, recordCommit, describeRepo, sharedPublicDir, checkInstallUpdate,
} from './lib/installs.mjs';
import {
  inspectInstall, installFromSource, updateFromSource, npmCommand, gitCommand, gameDir, parseChangelog, gitInfo,
  syncAssets, assetManifestHeld, localArtState, localExtractArgs,
} from './lib/repo.mjs';
import {
  fetchCatalog, applyMods, restoreGame, validateSelection,
} from './lib/mods.mjs';
import {
  RELEASE_SOURCES, releaseSourceById, listReleases, defaultAsset, installRelease, updateRelease,
  checkReleaseUpdate, updateAssetFor, ASSET_KINDS,
} from './lib/releases.mjs';
import {
  MODS_SOURCE, fetchModIndex, modRows, detectModSupport, installMod, removeMod, setModEnabled,
  installedMods, engineModList,
} from './lib/modsource.mjs';
import {
  readCatalog as readPluginCatalog, describeItem, pluginSupport, enginePluginList, pluginStateAll, writePluginState,
  installFromSource as installPluginFromSource, installFromZip, installFromUrl, removePlugin,
  installedPlugins, CATALOG_FILE,
} from './lib/pluginsource.mjs';
import {
  PLUGINS_DIR, POLICY_REL, SCOPE_TEXT, CLASS_SCOPE, CONTENT_CLASSES, SCRIPT_CLASSES, SCRIPT_MODES,
  pluginShape, preflight, lockHash, lockValid, readPolicy, writePolicy, trustGates, modeOf,
} from './lib/engineplugins.mjs';
import { checkUpdate, localHistory } from './lib/version.mjs';
import {
  checkSelf as checkSelfUpdate, applySelf, selfHistory, selfVersion, selfRemote, selfBranch, isSelfRepo,
} from './lib/selfupdate.mjs';
import {
  exists, openExternal, openFolder, localAddresses, hasCommand, runCapture, fetchWithTimeout, nowIso, prependPath, gitInstallHint, IS_WIN, IS_MAC, IS_LINUX,
  displayPath, formatBytes, mkdirp,
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
/** Per-version update checks, keyed by version id: { state, local, remote, incoming, checkedAt }. */
let versionChecks = {};
let checkingInstalls = false;
/** Release listings per source, kept in memory because `listReleases` also caches on disk. */
let releaseLists = {};
/** The community mod repository's index, and the active version's support mode. */
let modIndex = null;

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
    installs: listInstalls(config).map((v) => ({ ...v, check: versionChecks[v.id] || null })),
    activeInstallId: config.activeInstallId || null,
    checkingInstalls,
    shared: sharingEnabled ? sharedStatus(config) : { ...sharedStatus(config), disabled: true },
    version: versionInfo,
    checkingVersion,
    self: { ...selfInfo, updateReady: selfUpdateReady, checking: checkingSelf },
    network: { addresses: localAddresses(), share: game.shareUrls() },
    presets: allPresets(config),
    sources: SOURCES,
    channels: CHANNELS,
    releaseSources: RELEASE_SOURCES.map((r) => ({ id: r.id, label: r.label, slug: r.slug, desc: r.desc, recommended: r.recommended })),
    releases: releaseLists,
    assetKinds: ASSET_KINDS,
    modSource: modIndex
      ? {
        slug: MODS_SOURCE.slug, label: MODS_SOURCE.label, fetchedAt: modIndex.fetchedAt,
        count: modIndex.rows.length, engine: modIndex.index?.engine || null, source: modIndex.index?.source || null,
      }
      : { slug: MODS_SOURCE.slug, label: MODS_SOURCE.label, count: null },
    modSupport: activeInstall(config) ? detectModSupport(activeInstall(config).dir) : { mode: 'none', reason: '还没有版本。' },
    modInstalled: activeInstall(config) ? installedMods(activeInstall(config).id) : {},
    pluginSource: pluginSourceState(),
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

/**
 * The mod source index, read from its on-disk cache when it is still fresh. Keeping this lazy means a
 * restart does not force a network round trip, and an action never fails just because the page that
 * normally loads the index was not opened first.
 */
async function ensureModIndex({ force = false } = {}) {
  if (modIndex && !force) return modIndex;
  const cached = await fetchModIndex({
    force,
    cfg: config,
    log: (line, stream) => log({ channel: 'mods', stream: stream || 'meta', line }),
  });
  modIndex = { ...cached, rows: modRows(cached.index) };
  return modIndex;
}

/** Forget bookkeeping for plugins whose folder is gone. */
function dropStalePlugins(installId, keepIds) {
  const all = pluginStateAll();
  const e = all[installId];
  if (!e?.items) return;
  const items = {};
  for (const id of keepIds) if (e.items[id]) items[id] = e.items[id];
  writePluginState({ ...all, [installId]: { ...e, items } });
}

/**
 * The engine's view of one installed plugin, computed statically: what class and scope it declares, the
 * lock hash the owner would pin, and whether its data patches resolve against the installed game data.
 *
 * Reading a patch document and the data tables it names is not free (a modpack patch can be hundreds of
 * KB), and `buildState` runs on every emit, so the result is cached on a signature of the plugin folder
 * and the version's data files. A version update or a plugin change moves the signature.
 */
const engineInfoCache = new Map();

function versionDataSignal(dir) {
  try {
    const names = fs.readdirSync(path.join(dir, 'data')).filter((f) => f.endsWith('.json')).sort();
    return names.map((f) => `${f}:${fs.statSync(path.join(dir, 'data', f)).mtimeMs}`).join(',');
  } catch { return '?'; }
}

function enginePluginInfo(dir, id, dataSignal) {
  const key = `${dir}\n${id}`;
  const sig = `${dataSignal}|${(() => { try { return fs.statSync(path.join(dir, PLUGINS_DIR, id)).mtimeMs; } catch { return '?'; } })()}`;
  const hit = engineInfoCache.get(key);
  if (hit && hit.sig === sig) return hit.value;
  const shape = pluginShape(dir, id);
  let value;
  if (!shape.ok) value = { ok: false, reason: shape.reason };
  else {
    const hash = lockHash(dir, id);
    const locked = hash ? lockValid(dir, id, shape) : false;
    const pf = preflight(dir, id);
    value = {
      ok: true, id: shape.id, name: shape.name, version: shape.version, cls: shape.cls,
      scope: shape.scope, scopeText: shape.scope.map((s) => SCOPE_TEXT[s] || s),
      classScope: CLASS_SCOPE[shape.cls] || [],
      lockHash: hash, lockValid: locked,
      preflight: { applicable: pf.applicable, ok: pf.ok, needsHost: !!pf.needsHost, problems: pf.problems || [] },
    };
  }
  if (engineInfoCache.size > 128) engineInfoCache.clear();
  engineInfoCache.set(key, { sig, value });
  return value;
}

/** The owner's plugin policy as the UI needs it (policy.js fields plus the trusted pins). */
function pluginPolicyState(dir) {
  const r = readPolicy(dir, { pluginScripts: modeOf(config) });
  return {
    rel: POLICY_REL, file: displayPath(r.file), exists: r.exists,
    policy: r.policy, trusted: r.trusted, allowDownloadHosts: r.allowDownloadHosts,
    problems: r.problems, mode: modeOf(config),
  };
}

/** The trusted.js gates for one script/trusted plugin, using the policy as it is on disk right now. */
function trustState(info, policy, pinned) {
  if (!info?.ok || !SCRIPT_CLASSES.includes(info.cls)) return null;
  return trustGates({
    shape: { id: info.id, cls: info.cls, scope: info.scope },
    mode: modeOf(config), host: config.host, trusted: policy.trusted,
    locked: info.lockValid, hash: info.lockHash,
  }).map((g) => ({ ...g, pinned: !!pinned }));
}

/** One engine row plus everything the launcher can say about it. */
function engineRow(dir, id, dataSignal, policy) {
  const info = enginePluginInfo(dir, id, dataSignal);
  if (!info.ok) return { id, info };
  info.pinned = policy.trusted[info.id] === info.lockHash && !!info.lockHash;
  return { id, info, gates: trustState(info, policy, info.pinned) };
}

/**
 * The plugin catalogue as the UI needs it: the shipped list, each row checked against the active
 * version's engine, plus what the engine itself reports as installed.
 *
 * The catalogue is shipped with the launcher (so it is reviewable in git and needs no network), and it
 * holds no bytes — the packages come from their authors' repositories or from the user.
 */
function pluginSourceState() {
  const doc = readPluginCatalog();
  const entry = activeInstall(config);
  if (!entry) {
    return { available: false, reason: '还没有版本。', catalog: { count: doc.plugins.length, updatedAt: doc.updatedAt, note: doc.note }, items: [] };
  }
  const support = pluginSupport(entry.dir);
  const engine = support.engine || '';
  // Reconcile the bookkeeping with the filesystem: a folder removed by hand (or by the engine's own
  // uninstall) must not keep showing as installed. Stale records are dropped so the UI stays honest.
  const record = installedPlugins(entry.id);
  const installed = {};
  let healed = false;
  for (const [id, rec] of Object.entries(record)) {
    if (exists(path.join(entry.dir, PLUGINS_DIR, id))) installed[id] = rec;
    else healed = true;
  }
  if (healed) dropStalePlugins(entry.id, Object.keys(installed));
  const dataSignal = support.ok ? versionDataSignal(entry.dir) : '?';
  const policy = pluginPolicyState(entry.dir);
  const items = doc.plugins.map((i) => {
    const row = describeItem(i, { engine, installed });
    if (!support.ok) return row;
    // The engine reads whatever folder is in plugins/, so a plugin the user cloned or copied in by hand
    // is just as loadable as one we installed — and needs the same explanations.
    const onDisk = installed[row.id] || exists(path.join(entry.dir, PLUGINS_DIR, row.id));
    if (!onDisk) return row;
    const e = engineRow(entry.dir, row.id, dataSignal, policy);
    return { ...row, onDisk: true, engineInfo: e.info, gates: e.gates || null, pinned: !!e.info.pinned };
  });
  return {
    available: support.ok,
    reason: support.reason || '',
    engine,
    installDir: displayPath(entry.dir),
    catalog: { file: displayPath(CATALOG_FILE), count: doc.plugins.length, updatedAt: doc.updatedAt, note: doc.note },
    policy,
    scriptModes: SCRIPT_MODES,
    scopeText: SCOPE_TEXT,
    items,
  };
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
/**
 * Run one asset sync and report the outcome in terms a user can act on.
 * @param {object} ctx task context (log / trackChild / isCancelled)
 * @param {{strict:boolean, sync?:{done:boolean}}} o `sync` is the per-task marker that keeps the heal
 *   step from repeating what the previous step already did.
 */
async function runAssetSync(ctx, { strict, sync = { done: false } }) {
  sync.done = true;
  const r = await syncAssets(config, {
    log: (line, stream) => ctx.log(line, stream),
    trackChild: ctx.trackChild,
    isCancelled: ctx.isCancelled,
  });
  if (r.ok) return;
  // A version that owns its manifest can never satisfy the shrink guard: say so once and stop. The game
  // draws stand-ins for the few entries the mirrors lack, so this is not a broken install.
  if (r.ownedManifest) {
    ctx.log('素材已就绪；这个版本自带的清单里有几项公开镜像没有（它自己新增的内容），游戏会用替代样式显示这几项——这不是错误，无需重试。', 'meta');
    return;
  }
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
/**
 * The cleanup step after `tools/setup.mjs`: when its asset download was stopped by the manifest shrink
 * guard, sync again. Runs at most once per task and never right after another sync — the earlier pass
 * already applied the same remedies, and repeating it was measured as ten wasted minutes.
 * @param {string} dir game install directory
 * @param {{done:boolean}} [sync] per-task marker shared with the preceding sync step
 */
const assetHealStep = (dir, sync = { done: false }) => ({
  label: '补全美术 / 音频素材（必要时刷新上游索引）',
  run: async (ctx) => {
    if (sync.done) { ctx.log('本次任务已同步过素材，跳过这一步。', 'meta'); return; }
    if (!assetManifestHeld(dir)) return;
    ctx.log('上次素材同步保留了仓库里的 data/assets.json（上游索引可能已过期），重新同步…', 'meta');
    await runAssetSync(ctx, { strict: false, sync });
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
  } else if (entry.source === 'release') {
    // A version installed from a release has no working copy to clone: unpack the recorded asset.
    const rec = entry.release || {};
    if (!rec.assetUrl) throw new Error('这个版本没有记录安装来源（release 资产），请删除后在「版本」页重新添加。');
    installRelease(cfg, entry, {
      tag: rec.tag,
      asset: { name: rec.assetName, url: rec.assetUrl, size: rec.size || 0 },
      log: (line, stream) => ctx.log(line, stream),
    });
  } else if (gitCommand() && entry.repo) {
    cloneInstall(dir, entry.repo, entry.ref, { cfg, log: (line, stream) => ctx.log(line, stream) });
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
  // One marker per task: the setup step syncs assets, and the heal step must not immediately redo it.
  const sync = { done: false };

  if (action === 'full') {
    steps.push({
      label: '下载 / 检出游戏源码',
      run: (ctx) => ensureSources(ctx),
    });
    steps.push(linkStep());
    steps.push({ ...nodeStep('安装依赖、前端库并下载素材（可中断续传）', setupArgs(), dir, { env: setupEnv() }), onDone: () => { sync.done = true; } });
    steps.push(assetHealStep(dir, sync));
  } else if (action === 'repair') {
    steps.push(linkStep());
    steps.push({ ...nodeStep('检查并补全依赖与素材（可中断续传）', setupArgs(), dir, { env: setupEnv() }), onDone: () => { sync.done = true; } });
    steps.push(assetHealStep(dir, sync));
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
      run: (ctx) => runAssetSync(ctx, { strict: true, sync }),
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

/**
 * Update the active version from its own repository. This is the home page's 「更新到最新版本」.
 *
 * When the fetch produces no new commit there is nothing to rebuild, so the dependency and asset sync
 * is skipped — that sync is the expensive part (it re-plans and re-checks ~11k files), and running it
 * for an unchanged tree was measured as 26 wasted minutes. `resync` forces it anyway.
 * @param {boolean} force discard the version's local changes (git reset --hard)
 * @param {boolean} [resync] also run the dependency/asset sync when nothing changed
 */
async function runUpdate(force, resync = false) {
  if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
  const entry = activeInstall(config);
  if (!entry || !exists(path.join(entry.dir, 'package.json'))) {
    return { started: false, error: '还没有可更新的版本，请先在「版本」页安装一个。' };
  }
  if (game.running && config.activeInstallId === entry.id) {
    // The process holds the old code; updating underneath it would be a half-applied state.
    return { started: false, error: '这个版本正在运行：请先「停止服务器」再更新。' };
  }
  const dir = entry.dir;
  let changed = false;
  const sync = { done: false };
  const steps = [
    {
      label: force ? '获取最新版本（丢弃本地改动）' : '获取最新版本',
      run: (ctx) => {
        const r = updateInstall(config, entry, { force, log: (line, stream) => ctx.log(line, stream) });
        changed = r.changed;
        config = patchConfig({ installs: (config.installs || []).map((e) => (e.id === entry.id ? { ...e, commit: r.commit } : e)) });
        if (!r.changed) ctx.log('提交没有变化；已跳过依赖与素材同步（需要时可勾选「即使没有新提交也重新同步依赖与素材」）。', 'meta');
      },
    },
    {
      ...nodeStep('同步依赖与素材', setupArgs(), dir, { env: setupEnv() }),
      when: () => changed || resync,
      onDone: () => { sync.done = true; },
    },
    { ...assetHealStep(dir, sync), when: () => changed || resync },
  ];
  const promise = taskRunner.run('update', force ? '强制更新' : '更新版本', steps);
  promise.then(async (r) => {
    refreshInstall();
    if (r.ok) versionInfo = await checkUpdate(config, { deep: false });
    emitState();
    const label = changed ? '更新完成' : '已是最新（无需同步）';
    toast(r.ok ? label : '更新失败，可在「终端」查看原因', r.ok ? 'ok' : 'error', r.ok && !changed ? 6000 : 8000);
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
   * Check every version against its own repository. `body.id` limits it to one.
   * Replaces the old home-page check that compared the install with the selected download source —
   * meaningless once versions can come from different forks.
   */
  async installsCheckAll(body = {}) {
    if (checkingInstalls) return { checking: true };
    const targets = body.id ? (config.installs || []).filter((e) => e.id === body.id) : (config.installs || []);
    if (!targets.length) return { ok: false, error: '还没有版本可检查。' };
    checkingInstalls = true;
    emitState();
    log({ channel: 'update', stream: 'meta', line: `▶ 检查 ${targets.length} 个版本的更新…` });
    try {
      for (const entry of targets) {
        const logLine = (line) => log({ channel: 'update', stream: 'stdout', line });
        const r = entry.source === 'release'
          ? await checkReleaseUpdate(entry, { log: logLine })
          : checkInstallUpdate(entry, config, { log: logLine });
        versionChecks = { ...versionChecks, [entry.id]: { ...r, checkedAt: nowIso() } };
        const text = {
          equal: '已是最新', behind: `有 ${r.incoming.length || ''} 个新提交可更新`, ahead: '本地领先于远端',
          diverged: '与远端分叉（需要强制更新）', norepo: '没有记录来源仓库', unknown: '无法检查',
        }[r.state] || r.state;
        log({
          channel: 'update',
          stream: r.state === 'equal' ? 'stdout' : 'meta',
          line: `${r.state === 'equal' ? '✔' : '•'} ${entry.label}：${text}${r.local && r.remote ? `（${r.local.slice(0, 8)} → ${r.remote.slice(0, 8)}）` : ''}`,
        });
      }
      for (const e of targets) {
        const c = versionChecks[e.id];
        if (c?.state !== 'behind' || !c.incoming.length) continue;
        log({ channel: 'update', stream: 'stdout', line: `  ${e.label} 待更新提交（${c.incoming.length}）：` });
        for (const commit of c.incoming.slice(0, 8)) {
          log({ channel: 'update', stream: 'stdout', line: `    ${commit.hash} ${commit.date} ${commit.subject}` });
        }
        if (c.incoming.length > 8) log({ channel: 'update', stream: 'stdout', line: `    …另有 ${c.incoming.length - 8} 条` });
      }
    } finally {
      checkingInstalls = false;
      emitState();
    }
    return { ok: true, checks: versionChecks };
  },


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
    const label = String(body.label || '').trim().slice(0, 80);
    // A clone that failed earlier leaves the version registered but with no checkout (the folder is
    // removed again). Retrying the same repo/ref has to reuse that entry: adding a new one would keep
    // an orphan in the registry and put the retry under a `-2` id.
    const orphan = (config.installs || []).find((e) => e.repo === repo && (e.ref || BRANCH) === ref && !exists(path.join(e.dir, 'package.json')));
    let entry;
    if (orphan) {
      entry = { ...orphan, label: label || orphan.label };
      config = patchConfig({ activeInstallId: entry.id, installDir: entry.dir });
      log({ channel: 'deploy', stream: 'meta', line: `▶ 重试安装：${entry.label}（${repo} @ ${ref}）` });
    } else {
      const id = uniqueInstallId(config, installIdFor(repo, ref));
      entry = {
        id,
        label: label || `${repo.replace(/\.git$/, '').split('/').pop()}（${ref}）`,
        kind: /sganggs\/Stronghold-Protocol/.test(repo) ? 'upstream' : 'fork',
        repo, ref,
        dir: installDirFor(id),
        commit: '', linkMode: '', addedAt: nowIso(),
      };
      if (exists(path.join(entry.dir, 'package.json'))) return { started: false, error: `这个版本已经在列表里了（目录已存在）：${entry.dir}` };
      config = patchConfig({ installs: [...(config.installs || []), entry], activeInstallId: entry.id, installDir: entry.dir });
      log({ channel: 'deploy', stream: 'meta', line: `▶ 新版本：${entry.label}（${repo} @ ${ref}）` });
    }
    const promise = taskRunner.run('deploy', `安装版本：${entry.label}`, deploySteps('full'));
    promise.then((r) => {
      refreshInstall();
      emitState();
      toast(r.ok ? `版本「${entry.label}」已安装` : '安装失败，可在「终端」查看原因', r.ok ? 'ok' : 'error', 8000);
    });
    return { started: true, id: entry.id };
  },

  /**
   * The releases of one source (`body.sourceId`), newest first. Cached on disk for half an hour by
   * `listReleases`; `force` re-reads.
   */
  async releasesList(body = {}) {
    const id = String(body.sourceId || 'upstream');
    const src = releaseSourceById(id);
    const listed = await listReleases(id, {
      force: body.force === true,
      log: (line, stream) => log({ channel: 'deploy', stream: stream || 'meta', line }),
    });
    releaseLists = { ...releaseLists, [id]: listed };
    emitState();
    return { ok: true, sourceId: id, label: src.label, ...listed };
  },

  /**
   * Install a version straight from a GitHub Release. `body = { sourceId, tag, assetName, label }`.
   *
   * This is the route for anyone without git, and it is much faster than a clone-and-setup: the
   * published packages already contain `node_modules` and `public/vendor`, so nothing is installed
   * afterwards — only the art is linked to the shared store.
   */
  async installsAddRelease(body = {}) {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    const id = String(body.sourceId || 'upstream');
    const src = releaseSourceById(id);
    let listed = releaseLists[id];
    if (!listed) {
      listed = await listReleases(id, { log: (line, stream) => log({ channel: 'deploy', stream: stream || 'meta', line }) });
      releaseLists = { ...releaseLists, [id]: listed };
    }
    const rel = (listed.releases || []).find((r) => r.tag === String(body.tag || ''));
    if (!rel) return { started: false, error: `找不到 release ${body.tag}（列表可能已过期，请点「刷新」）。` };
    const asset = body.assetName
      ? (rel.assets || []).find((a) => a.name === String(body.assetName))
      : defaultAsset(rel, src);
    if (!asset) return { started: false, error: '这个 release 里没有找到那个文件。' };
    if (!asset.usable) {
      return { started: false, error: `${asset.label}不能单独安装：${asset.hint}` };
    }

    const slug = src.slug;
    const newId = uniqueInstallId(config, installIdFor(`https://github.com/${slug}`, rel.tag));
    const entry = {
      id: newId,
      label: String(body.label || '').trim().slice(0, 80) || `${src.label} ${rel.tag}`,
      kind: id === 'upstream' ? 'upstream' : 'fork',
      // A release install has no working copy: `source` says how to update it, and `repo` stays empty
      // so nothing mistakes it for something `git fetch` could handle.
      source: 'release',
      repo: '',
      sourceUrl: `https://github.com/${slug}`,
      ref: rel.tag,
      dir: installDirFor(newId),
      release: {
        sourceId: id, slug, tag: rel.tag, assetName: asset.name, assetUrl: asset.url,
        assetKind: asset.kind, size: asset.size,
      },
      commit: '', linkMode: '', addedAt: nowIso(),
    };
    if (exists(path.join(entry.dir, 'package.json'))) return { started: false, error: `目录已存在：${entry.dir}` };
    config = patchConfig({ installs: [...(config.installs || []), entry], activeInstallId: entry.id, installDir: entry.dir });
    log({ channel: 'deploy', stream: 'meta', line: `▶ 从 Release 安装：${entry.label}（${rel.tag} · ${asset.name}）` });
    const promise = taskRunner.run('deploy', `从 Release 安装：${entry.label}`, deploySteps('full'));
    promise.then((r) => {
      refreshInstall();
      emitState();
      toast(r.ok ? `版本「${entry.label}」已安装` : '安装失败，可在「终端」查看原因', r.ok ? 'ok' : 'error', 8000);
    });
    return { started: true, id: entry.id };
  },

  /** (Re)read the community mod repository's manifest. */
  async modSourceRefresh(body = {}) {
    const idx = await ensureModIndex({ force: body.force === true });
    log(`✔ mod 源：${idx.rows.length} 个包${idx.cached ? '（来自本地缓存）' : ''}`, 'stdout');
    emitState();
    return { ok: true, count: idx.rows.length, cached: idx.cached, fetchedAt: idx.fetchedAt, rows: idx.rows };
  },

  /** Install one mod from the source into the active version. */
  async modSourceInstall(body = {}) {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    const entry = activeInstall(config);
    if (!entry) return { started: false, error: '还没有版本，请先在「版本」页安装一个。' };
    let idx;
    try {
      idx = await ensureModIndex();
    } catch (e) {
      return { started: false, error: `读取 mod 源失败：${String(e.message || e)}` };
    }
    const mod = idx.rows.find((m) => m.id === String(body.id || ''));
    if (!mod) return { started: false, error: '目录里没有这个包。' };
    const support = detectModSupport(entry.dir);
    if (support.mode === 'none') return { started: false, error: support.reason };

    let lastPct = -1;
    const steps = [{
      label: `安装 mod：${mod.name}`,
      run: async (ctx) => {
        const r = await installMod(config, entry, mod, {
          log: (line, stream) => ctx.log(line, stream),
          onProgress: (loaded, total) => {
            // Tiny packs finish between reports; only a real download is worth a progress line.
            if (!total || total < 1e6) return;
            const pct = Math.floor((loaded / total) * 100);
            if (pct >= lastPct + 10) { lastPct = pct; ctx.log(`  下载 ${pct}%（${Math.round(loaded / 1e6)}/${Math.round(total / 1e6)} MB）`, 'stdout'); }
          },
        });
        const how = r.mode === 'workshop' ? '工坊包' : `插件（${(r.products || []).join('、')}）`;
        ctx.log(`✔ 已安装为${how}`, 'stdout');
        if (game.running) ctx.log('提示：服务器正在运行；重启一次「启动服务器」即可生效。', 'meta');
        return r;
      },
    }];
    const promise = taskRunner.run('mods', `安装 mod：${mod.name}`, steps);
    promise.then(() => { emitState(); });
    return { started: true, id: mod.id, mode: support.mode };
  },

  /** Uninstall a mod this launcher installed (the engine keeps its own backup). */
  async modSourceRemove(body = {}) {
    const entry = activeInstall(config);
    if (!entry) return { ok: false, error: '还没有版本。' };
    if (game.running) return { ok: false, error: '请先「停止服务器」再卸载 mod。' };
    try {
      const r = await removeMod(config, entry, String(body.id || ''), {
        log: (line, stream) => log({ channel: 'mods', stream: stream || 'stdout', line }),
      });
      emitState();
      toast(r.mode === 'workshop' ? '已卸载（引擎留了备份）' : '已卸载', 'ok', 6000);
      return { ok: true, mode: r.mode };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  },

  /** Enable / disable an installed workshop pack (the engine's own registry owns the switch). */
  async modSourceToggle(body = {}) {
    const entry = activeInstall(config);
    if (!entry) return { ok: false, error: '还没有版本。' };
    try {
      const r = await setModEnabled(config, entry, String(body.id || ''), body.enabled === true, {
        log: (line, stream) => log({ channel: 'mods', stream: stream || 'stdout', line }),
      });
      emitState();
      return { ok: true, enabled: r.enabled };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  },

  /** The engine's own list of installed mods, for cross-checking. */
  async modSourceEngineList() {
    const entry = activeInstall(config);
    if (!entry) return { ok: false, error: '还没有版本。' };
    return { ok: true, ...engineModList(entry) };
  },

  /**
   * The shipped plugin catalogue plus the engine's own view of what is installed. The engine's list is
   * the authority on `status`; our static reading adds what the engine does not print — whether a
   * content plugin's patches would resolve, and which owner gate a script plugin fails.
   */
  async pluginSourceList() {
    const state = pluginSourceState();
    const entry = activeInstall(config);
    if (!entry || !state.available) return { ok: true, ...state, engineList: null };
    const list = enginePluginList(entry.dir);
    const dataSignal = versionDataSignal(entry.dir);
    const policy = state.policy;
    const known = new Map(state.items.filter((i) => i.engineInfo?.ok).map((i) => [i.id, i.engineInfo]));
    return {
      ok: true, ...state,
      engineList: list.ok ? {
        ...list,
        plugins: list.plugins.map((p) => {
          const row = engineRow(entry.dir, p.id, dataSignal, policy);
          return { ...p, engineInfo: row.info?.ok ? row.info : null, gates: row.gates || null };
        }),
      } : list,
    };
  },

  /**
   * Save the owner's plugin policy (plugins/config.json). Only the keys the UI owns are written; every
   * other key — including `allowDownloadHosts`, which the engine's installer reads from the same file —
   * is left exactly as it was.
   */
  async pluginPolicySave(body = {}) {
    const entry = activeInstall(config);
    if (!entry) return { ok: false, error: '还没有版本。' };
    const current = readPolicy(entry.dir, { pluginScripts: modeOf(config) });
    const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean);
    const next = {};
    if (body.rooms !== undefined) next.rooms = String(body.rooms);
    if (body.default !== undefined) next.default = list(body.default);
    if (body.allow !== undefined) next.allow = list(body.allow);
    if (body.classes !== undefined) {
      const cls = body.classes && typeof body.classes === 'object' && !Array.isArray(body.classes) ? body.classes : {};
      next.classes = { ...cls };
    }
    if (body.maxSets !== undefined) next.limits = { maxSets: Number(body.maxSets) };
    if (body.allowIncompatible !== undefined) next.allowIncompatible = body.allowIncompatible === true;
    if (body.allowDownloadHosts !== undefined) next.allowDownloadHosts = list(body.allowDownloadHosts);
    const r = writePolicy(entry.dir, next);
    if (!r.ok) return { ok: false, error: r.reason };
    log({ channel: 'mods', stream: 'meta', line: `▶ 已写入 ${POLICY_REL}：${Object.keys(next).join(', ') || '（无改动）'}` });
    emitState();
    return { ok: true, policy: pluginPolicyState(entry.dir) };
  },

  /**
   * Pin (or unpin) a script plugin's lock hash in plugins/config.json. The pin is the sha256 of the
   * plugin.lock.json bytes, so it changes every time the author repacks — pinning a plugin whose lock
   * does not currently match its files would only hide the real refusal, so that is refused here too.
   */
  async pluginTrustPin(body = {}) {
    const entry = activeInstall(config);
    if (!entry) return { ok: false, error: '还没有版本。' };
    const id = String(body.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) return { ok: false, error: '插件 id 不合法。' };
    const shape = pluginShape(entry.dir, id);
    if (!shape.ok) return { ok: false, error: shape.reason };
    if (!SCRIPT_CLASSES.includes(shape.cls)) return { ok: false, error: `${id} 是 ${shape.cls} 类，不需要授权钉住。` };
    const current = readPolicy(entry.dir, { pluginScripts: modeOf(config) });
    const trusted = { ...current.trusted };
    if (body.on === false) {
      delete trusted[id];
    } else {
      const hash = lockHash(entry.dir, id);
      if (!hash) return { ok: false, error: `${id} 没有 plugin.lock.json：先用引擎的 pack 生成。` };
      if (!lockValid(entry.dir, id, shape)) {
        return { ok: false, error: `${id} 的 lock 与文件不符（文件被改过或 lock 过期），先重新打包再钉住。` };
      }
      trusted[id] = hash;
      log({ channel: 'mods', stream: 'meta', line: `▶ 已钉住 ${id}：${hash.slice(0, 16)}…（每次重新打包都会变）` });
    }
    const r = writePolicy(entry.dir, { trusted });
    if (!r.ok) return { ok: false, error: r.reason };
    if (body.on === false) log({ channel: 'mods', stream: 'meta', line: `▶ 已取消钉住 ${id}` });
    emitState();
    return { ok: true, pinned: body.on !== false, policy: pluginPolicyState(entry.dir) };
  },

  /**
   * Install a plugin. Three shapes, one action:
   *   `{ id }`                  → fetch the folder from the repository recorded in the catalogue
   *   `{ url }`                 → download a zip the user pointed at, then install it
   *   `{ zip, name }`           → a zip the user handed us (base64), e.g. from a file picker
   */
  async pluginSourceInstall(body = {}) {
    if (taskRunner.busy) return { started: false, error: '已有任务正在运行。' };
    const entry = activeInstall(config);
    if (!entry) return { started: false, error: '还没有版本。' };
    const support = pluginSupport(entry.dir);
    if (!support.ok) return { started: false, error: support.reason };

    const id = String(body.id || '').trim();
    const url = String(body.url || '').trim();
    const zipB64 = typeof body.zip === 'string' ? body.zip : '';
    const item = id ? readPluginCatalog().plugins.map((i) => describeItem(i, { engine: support.engine })).find((i) => i.id === id) : null;
    if (id && !item) return { started: false, error: '目录里没有这个插件。' };
    if (item?.manual) return { started: false, error: `${item.name} 不能由启动器安装：${item.manualReason}` };
    if (!id && !url && !zipB64) return { started: false, error: '请选择一个插件、一个 zip 文件，或一个地址。' };
    if (url && !/^https:\/\//i.test(url)) return { started: false, error: '地址需要是 https 开头。' };

    let lastPct = -1;
    const onProgress = (loaded, total, ctx) => {
      if (!total || total < 1e6) return;
      const pct = Math.floor((loaded / total) * 100);
      if (pct >= lastPct + 10) { lastPct = pct; ctx.log(`  ${pct}%（${Math.round(loaded / 1e6)}/${Math.round(total / 1e6)} MB）`, 'stdout'); }
    };

    const label = item ? `${item.name}（${item.id}）` : (url || body.name || '外部 zip');
    const steps = [{
      label: `安装插件：${item?.name || label}`,
      run: async (ctx) => {
        if (zipB64) {
          const safe = String(body.name || 'plugin.zip').replace(/[^\w.\-]+/g, '_').slice(-80) || 'plugin.zip';
          const tmp = path.join(ROOT, '.cache', 'plugins', safe);
          mkdirp(path.dirname(tmp));
          fs.writeFileSync(tmp, Buffer.from(zipB64, 'base64'));
          ctx.log(`▶ 收到 zip（${formatBytes(fs.statSync(tmp).size)}）`, 'meta');
          const r = installFromZip(entry, tmp, { log: (l, st) => ctx.log(l, st) });
          ctx.log('✔ 已安装；下次载入页面时引擎就会认到（无需重启）。', 'stdout');
          return r;
        }
        // Prefer the author's own zip (pinned to a hash we verified) over fetching their whole repo.
        const target = url || item?.dist?.url;
        if (target) {
          const r = await installFromUrl(entry, target, {
            sha256: item?.dist?.sha256 || (body.sha256 ? String(body.sha256) : ''),
            expectBytes: item?.dist?.bytes || 0,
            log: (l, st) => ctx.log(l, st),
            onProgress: (a, b) => onProgress(a, b, ctx),
          });
          ctx.log('✔ 已安装；下次载入页面时引擎就会认到（无需重启）。', 'stdout');
          return r;
        }
        const r = await installPluginFromSource(entry, item, { log: (l, st) => ctx.log(l, st), onProgress: (a, b) => onProgress(a, b, ctx) });
        if (item.class === 'script' || item.class === 'trusted') {
          ctx.log('注意：这一类默认不执行，要服主开启（SP_PLUGIN_SCRIPTS）并在房间里逐人同意。', 'meta');
        } else {
          ctx.log('✔ 已安装；下次载入页面时引擎就会认到（无需重启）。', 'stdout');
        }
        return r;
      },
    }];
    const promise = taskRunner.run('mods', `安装插件：${item?.name || label}`, steps);
    promise.then(() => { emitState(); });
    return { started: true, id: item?.id || '', from: zipB64 ? 'zip' : (url ? 'url' : 'source') };
  },

  /** Remove a plugin this launcher installed. */
  async pluginSourceRemove(body = {}) {
    const entry = activeInstall(config);
    if (!entry) return { ok: false, error: '还没有版本。' };
    try {
      const r = removePlugin(entry, String(body.id || ''), {
        log: (line, stream) => log({ channel: 'mods', stream: stream || 'stdout', line }),
      });
      emitState();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
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
    const resync = body.resync === true;
    const dir = entry.dir;
    // Same no-op rule as the home path: an unchanged tree has nothing to rebuild, and the dependency /
    // asset sync is the expensive part (it re-plans ~11k files).
    let changed = false;
    const sync = { done: false };
    const steps = [
      {
        label: force ? '更新版本（丢弃该版本的本地改动）' : '更新版本',
        run: async (ctx) => {
          const lg = (line, stream) => ctx.log(line, stream);
          if (entry.source === 'release') {
            // No git here: the update is the newest release's asset of the same kind, unpacked over
            // the version while dependencies, art and installed mods are preserved.
            const next = await updateAssetFor(entry, { log: lg });
            if (!next) throw new Error('找不到可用的更新资产；请删除这个版本后重新安装。');
            const before = entry.release?.tag || '';
            changed = next.tag !== before;
            if (!changed) { ctx.log(`✔ 已是最新（${before}）`, 'stdout'); return; }
            await updateRelease(config, entry, { tag: next.tag, asset: next.asset, log: lg });
            config = patchConfig({
              installs: (config.installs || []).map((e) => (e.id === entry.id
                ? { ...e, ref: next.tag, release: { ...e.release, tag: next.tag, assetName: next.asset.name, assetUrl: next.asset.url, assetKind: next.asset.kind, size: next.asset.size } }
                : e)),
            });
            if (!resync) ctx.log('已解压新版本；依赖与素材未变，跳过同步（需要时可勾选「即使没有新提交也重新同步」）。', 'meta');
            return;
          }
          const r = updateInstall(config, entry, { force, log: lg });
          changed = r.changed;
          config = patchConfig({ installs: (config.installs || []).map((e) => (e.id === entry.id ? { ...e, commit: r.commit } : e)) });
          if (!r.changed) ctx.log('提交没有变化；已跳过依赖与素材同步（需要时可勾选「即使没有新提交也重新同步」）。', 'meta');
        },
      },
      {
        ...nodeStep('同步依赖与素材', setupArgs(), dir, { env: setupEnv() }),
        when: () => changed || resync,
        onDone: () => { sync.done = true; },
      },
      { ...assetHealStep(dir, sync), when: () => changed || resync },
    ];
    const promise = taskRunner.run('update', `更新版本：${entry.label}`, steps);
    promise.then((r) => {
      refreshInstall();
      if (r.ok) versionChecks = { ...versionChecks, [entry.id]: { ...checkInstallUpdate(entry, config, { log: () => {} }), checkedAt: nowIso() } };
      emitState();
      toast(r.ok ? (changed ? `版本「${entry.label}」已更新` : `版本「${entry.label}」已是最新（未重新同步）`) : '更新失败，可在「终端」查看原因', r.ok ? 'ok' : 'error', 8000);
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
  update: (force, resync) => runUpdate(force, resync),
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

  // One check mechanism: each version against its own repository (the old "install vs download source"
  // comparison is meaningless now that versions can come from different forks).
  if (config.autoUpdateCheck && (config.installs || []).length) {
    setTimeout(() => { actions.installsCheckAll(); }, 800);
    // Read the mod source's manifest in the background so the mod page has its list ready, and a
    // restart never makes the first install fail with "目录还没读取".
    setTimeout(() => { ensureModIndex().then(() => emitState()).catch(() => { /* offline is fine */ }); }, 1200);
  }

  process.on('SIGINT', () => { console.log('\n收到 Ctrl+C，正在退出…'); shutdown(0); });
  process.on('SIGTERM', () => shutdown(0));
}

main().catch((e) => {
  console.error('启动器启动失败：', e?.stack || e);
  process.exit(1);
});
