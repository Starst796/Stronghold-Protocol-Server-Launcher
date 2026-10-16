// The two server-side decisions the engine makes about a plugin, reproduced so the launcher can explain
// them before a room is opened.
//
// 1. A `content` plugin only composes once every data patch in it resolves against the installed game
//    data (server/plugins/contentSet.js → shared/plugins/patch.js). A patch that writes a namespace the
//    vanilla data does not have — the "host adapter layer" a modpack author ships as a separate patch —
//    fails there, and because a room reports an unknown problem code as PLUGIN_BLOCKED
//    (server/plugins/contentSets.js), the host only ever sees "该插件不能在房间中启用".
// 2. A `script`/`trusted` plugin only loads once the owner opts in: SP_PLUGIN_SCRIPTS, a listening address
//    that is not public, and a lock pin in plugins/config.json (server/plugins/trusted.js).
//
// Everything below is a port of those rules, kept deliberately conservative: a plugin is reported only
// when the refusal is certain, so a false "may be refused" note never appears. Nothing here executes
// plugin code and nothing here is authoritative — the engine still decides at load time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const nodeSha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => v != null && Object.hasOwn(v, k);
const forbidden = (k) => ['__proto__', 'prototype', 'constructor'].includes(String(k));

/** patch.js PATCH_OPS. */
const PATCH_OPS = ['set', 'merge', 'add', 'append', 'remove'];
/** patch.js RECORD_MAPS: the tables whose records need a namespaced id. */
const RECORD_MAPS = Object.freeze({
  chess: ['chess_x'], enemies: ['enemy_x'], items: ['item_x'], bands: ['band_x'], garrisons: ['garrison_x'],
  effects: ['effect_x'], waves: ['wave_x'], stages: ['stage_x'], tokens: ['token_x'],
});
const namespace = (id) => String(id).replace(/-/g, '_');
const recordId = (id, pluginId, prefix) => typeof id === 'string' && id.length <= 64
  && /^[A-Za-z0-9_-]+$/.test(id)
  && (pluginId ? id.startsWith(`${prefix}_${namespace(pluginId)}_`) : new RegExp(`^${prefix}_[a-z0-9_]+_[A-Za-z0-9_-]+$`).test(id));
const addPrefix = (file, p) => RECORD_MAPS[file]?.[0] ?? (file === 'config' && p.join('.') === 'modes' ? 'mode_x' : null);

export const PLUGINS_DIR = 'plugins';
export const POLICY_REL = `${PLUGINS_DIR}/config.json`;

/** The plugin classes whose manifests carry data patches, per contentSet.js. */
export const CONTENT_CLASSES = ['content', 'script', 'trusted'];
/** The classes the engine refuses to execute without an owner opt-in (trusted.js `isScriptClass`). */
export const SCRIPT_CLASSES = ['script', 'trusted'];
/** SP_PLUGIN_SCRIPTS values, in the order the UI offers them. */
export const SCRIPT_MODES = ['off', 'sandbox', 'trusted', 'trusted-force'];

/** What each scope means, in the engine's own words (plugin.schema.json `scope`). */
export const SCOPE_TEXT = {
  room: '房主在房间里开',
  personal: '每位玩家只给自己开',
  server: '服务器启动时加载（需授权）',
};
/** The class → scope table the engine documents (docs/PLUGINS.md §2). */
export const CLASS_SCOPE = {
  lang: ['personal'], cosmetic: ['room', 'personal'], content: ['room'], script: ['room'],
  ui: ['personal'], trusted: ['server', 'room'],
};

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/** The engine's data tables, read one at a time (only the ones a patch names). */
function dataReader(dir) {
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    const v = /^[a-z0-9_]+$/.test(name) ? readJson(path.join(dir, 'data', `${name}.json`)) : null;
    cache.set(name, v);
    return v;
  };
}

/**
 * A plugin's manifest, read from disk. Only the fields this module needs are used, so a newer manifest
 * format degrades to "nothing to report" instead of an error.
 * @param {string} dir the version directory @param {string} id the plugin folder name
 */
export function pluginShape(dir, id) {
  const base = path.join(dir, PLUGINS_DIR, id);
  const man = readJson(path.join(base, 'plugin.json'));
  if (!man) return { ok: false, dir: base, reason: '读不到 plugin.json' };
  const one = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    ok: true,
    dir: base,
    id: man.id || id,
    name: typeof man.name === 'string' ? man.name : man.englishName || id,
    version: typeof man.version === 'string' ? man.version : '',
    app: typeof man.app === 'string' ? man.app : '',
    cls: typeof man.class === 'string' ? man.class : '',
    scope: Array.isArray(man.scope) ? man.scope : typeof man.scope === 'string' ? [man.scope] : [],
    permissions: Array.isArray(man.permissions) ? man.permissions : [],
    // Only the `data` part carries patch documents (contentSet.js); the others are record lists.
    dataFiles: one(man.data),
    hasEntry: object(man.entry),
  };
}

/** sha256 of a plugin's plugin.lock.json, as the engine pins it (trusted.js `readScripts`). */
export function lockHash(dir, id) {
  try { return nodeSha256(fs.readFileSync(path.join(dir, PLUGINS_DIR, id, 'plugin.lock.json'))); } catch { return null; }
}

/** Is the plugin's lock still valid for its files? A pin without a valid lock never loads (trusted.js). */
export function lockValid(dir, id, shape = pluginShape(dir, id)) {
  const base = path.join(dir, PLUGINS_DIR, id);
  const lock = readJson(path.join(base, 'plugin.lock.json'));
  if (!lock || lock.lock !== 1 || lock.id !== (shape.id || id) || lock.version !== shape.version) return false;
  const files = lock.files || {};
  const listed = [];
  const walk = (rel) => {
    let st;
    try { st = fs.lstatSync(path.join(base, rel)); } catch { return; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(path.join(base, rel))) walk(`${rel}/${e}`); return; }
    listed.push(rel);
  };
  for (const e of fs.readdirSync(base)) walk(e);
  const actual = listed.filter((rel) => rel !== 'plugin.lock.json');
  if (actual.length !== Object.keys(files).length) return false;
  return actual.every((rel) => {
    const rec = files[rel];
    if (!rec) return false;
    try {
      const bytes = fs.readFileSync(path.join(base, rel));
      return rec.bytes === bytes.length && rec.sha256 === nodeSha256(bytes);
    } catch { return false; }
  });
}

const hasSetting = (v) => Array.isArray(v) ? v.some(hasSetting)
  : object(v) ? (own(v, '$setting') || Object.values(v).some(hasSetting)) : false;
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** patch.js: a value is only compatible with a field of the same kind. */
function typeProblems(old, value, at, out) {
  if (hasSetting(value)) return; // resolved from the host's settings at compose time: unknown here
  if (kind(old) !== kind(value)) { out.push({ kind: 'type', code: 'PLUGIN_PATCH_TYPE', at, detail: `字段类型是 ${kind(old)}，补丁给的是 ${kind(value)}` }); return; }
  if (object(old) && object(value)) {
    for (const [k, v] of Object.entries(value)) if (own(old, k)) typeProblems(old[k], v, `${at}.${k}`, out);
  }
}

/**
 * Would this plugin's data patches resolve against the installed game data? Returns only the refusals
 * that are certain, each with the path the engine would name.
 *
 * `needsHost` marks the case that matters most: the patch wants a namespace (or a field) the vanilla data
 * does not have, which is what a modpack's separate "host adapter" patch would have created. The engine
 * refuses such a plugin in a room and the message it shows the host does not say so.
 */
export function preflight(dir, id) {
  const shape = pluginShape(dir, id);
  if (!shape.ok) return { applicable: false, ok: false, needsHost: false, problems: [], reason: shape.reason };
  if (!CONTENT_CLASSES.includes(shape.cls)) return { applicable: false, ok: true, needsHost: false, problems: [], shape };
  if (!shape.dataFiles.length) return { applicable: true, ok: true, needsHost: false, problems: [], shape };
  const data = dataReader(dir);
  const problems = [];
  for (const rel of shape.dataFiles) {
    const doc = readJson(path.join(shape.dir, ...rel.split('/')));
    if (!object(doc) || doc.patch !== 1 || !Array.isArray(doc.ops)) continue; // records:1 or unreadable
    for (const [i, op] of doc.ops.entries()) {
      const at = `${rel} ops[${i}]`;
      try {
        if (!object(op) || !PATCH_OPS.includes(op.op)) { problems.push({ kind: 'broken', code: 'PLUGIN_PATCH_OP', at, detail: '未知的补丁操作' }); continue; }
        const file = op.file;
        const table = own(op, 'file') ? data(file) : null;
        if (!own(op, 'file') || !object(table)) { problems.push({ kind: 'broken', code: 'PLUGIN_PATCH_PATH', at, detail: `游戏没有数据表 ${JSON.stringify(file)}` }); continue; }
        if (!Array.isArray(op.path ?? []) || (op.path ?? []).some((k) => !(typeof k === 'string' || Number.isInteger(k)) || forbidden(k))) {
          problems.push({ kind: 'broken', code: 'PLUGIN_PATCH_PATH', at, detail: 'path 里有不安全的键' }); continue;
        }
        if (op.id !== undefined && (typeof op.id !== 'string' || forbidden(op.id))) { problems.push({ kind: 'broken', code: 'PLUGIN_PATCH_PATH', at, detail: 'id 不合法' }); continue; }
        const full = op.op === 'add' ? [...(op.path ?? []), op.id] : [...(op.id === undefined ? [] : [op.id]), ...(op.path ?? [])];
        if (!full.length || full.some((k) => k === undefined || forbidden(k))) { problems.push({ kind: 'broken', code: 'PLUGIN_PATCH_PATH', at, detail: '缺少记录或字段路径' }); continue; }
        let target = table;
        let missing = null;
        for (const k of full.slice(0, -1)) {
          if (!own(target, k) || !target[k] || typeof target[k] !== 'object') { missing = k; break; }
          target = target[k];
        }
        if (missing !== null) {
          const where = [file, ...full.slice(0, -1)].slice(0, [file, ...full.slice(0, -1)].indexOf(missing) + 1).join('.');
          problems.push({ kind: 'missing', code: 'PLUGIN_PATCH_PATH', at, detail: `没有 ${where} 这一级`, path: where });
          continue;
        }
        const key = full.at(-1);
        const exists = own(target, key);
        if (Array.isArray(target) && !(Number.isInteger(Number(key)) && Number(key) >= 0 && Number(key) < target.length)) {
          problems.push({ kind: 'missing', code: 'PLUGIN_PATCH_PATH', at, detail: `数组下标 ${key} 超出范围`, path: `${file}.${full.slice(0, -1).join('.')}` });
          continue;
        }
        if (op.op === 'add') {
          const prefix = addPrefix(file, op.path ?? []);
          if (!prefix || !recordId(op.id, shape.id, prefix) || (file !== 'config' && (op.path ?? []).length)) {
            problems.push({ kind: 'broken', code: 'PLUGIN_RECORD_ID', at, detail: `新记录 id 需要 ${prefix ? `${prefix}_${namespace(shape.id)}_…` : '带命名空间'}`, path: `${file}.${op.id}` });
          } else if (exists) {
            problems.push({ kind: 'broken', code: 'PLUGIN_RECORD_EXISTS', at, detail: `记录 ${op.id} 已存在`, path: `${file}.${op.id}` });
          }
          continue;
        }
        if (!exists) {
          problems.push({ kind: 'missing', code: 'PLUGIN_PATCH_PATH', at, detail: `没有 ${[file, ...full].join('.')} 这个字段`, path: [file, ...full].join('.') });
          continue;
        }
        const value = own(op, 'value') ? op.value : undefined;
        if (op.op === 'set') {
          if (value === undefined) problems.push({ kind: 'broken', code: 'PLUGIN_PATCH_TYPE', at, detail: 'set 缺少 value' });
          else typeProblems(target[key], value, [file, ...full].join('.'), problems);
        } else if (op.op === 'merge') {
          if (!object(target[key]) || !object(value)) problems.push({ kind: 'broken', code: 'PLUGIN_PATCH_TYPE', at, detail: 'merge 两侧都必须是对象' });
          else typeProblems(target[key], value, [file, ...full].join('.'), problems);
        } else if (op.op === 'append') {
          if (!Array.isArray(target[key]) || !Array.isArray(value)) problems.push({ kind: 'broken', code: 'PLUGIN_PATCH_TYPE', at, detail: 'append 两侧都必须是数组' });
        } else if (op.op === 'remove') {
          if (!Array.isArray(target[key]) || !own(op, 'match')) problems.push({ kind: 'broken', code: 'PLUGIN_PATCH_TYPE', at, detail: 'remove 只对数组生效，并且需要 match' });
        }
      } catch (e) {
        problems.push({ kind: 'broken', code: 'PLUGIN_PATCH_TYPE', at, detail: String(e?.message || e) });
      }
    }
  }
  // One note per distinct path: a modpack patch writes the same missing namespace from every operation.
  const seen = new Set();
  const unique = problems.filter((p) => { const k = `${p.kind}:${p.path || p.at}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return {
    applicable: true, ok: unique.length === 0, needsHost: unique.some((p) => p.kind === 'missing'),
    problems: unique.slice(0, 8), shape,
  };
}

// ------------------------------------------------------------------------------------------------
// plugins/config.json — the owner's plugin policy (server/plugins/policy.js) and its trusted pins
// ------------------------------------------------------------------------------------------------

/** policy.js DEFAULT_POLICY. */
export const DEFAULT_POLICY = Object.freeze({
  rooms: 'host', default: [], allow: ['*'],
  classes: { cosmetic: true, content: true }, maxSets: 4, allowIncompatible: false,
});

const ROOMS = ['host', 'fixed', 'off'];
const isPluginId = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{1,31}$/.test(v);
const isSha256 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/**
 * Normalise the policy file the way policy.js does: a bad field keeps its default and is reported.
 * @param {unknown} json @param {{ pluginScripts?: string }} [cfg]
 */
export function readPolicyJson(json, cfg = {}) {
  const problems = [];
  const o = object(json) ? json : {};
  if (json != null && !object(json)) problems.push('文件内容不是 JSON 对象');
  // A class the environment does not switch on stays off even if the file lists it (policy.js).
  const classes = { ...DEFAULT_POLICY.classes };
  if (cfg.pluginScripts === 'sandbox') classes.script = true;
  if (['trusted', 'trusted-force'].includes(cfg.pluginScripts)) { classes.script = true; classes.trusted = true; }
  const p = { ...DEFAULT_POLICY, classes, default: [], allow: ['*'] };
  if (o.rooms !== undefined) { if (ROOMS.includes(o.rooms)) p.rooms = o.rooms; else problems.push(`"rooms" 只能是 ${ROOMS.join(' / ')}`); }
  if (o.default !== undefined) {
    if (Array.isArray(o.default) && o.default.length <= 32 && o.default.every(isPluginId)) p.default = [...new Set(o.default)];
    else problems.push('"default" 必须是插件 id 的列表');
  }
  if (o.allow !== undefined) {
    if (Array.isArray(o.allow) && o.allow.every((x) => x === '*' || isPluginId(x))) p.allow = [...o.allow];
    else problems.push('"allow" 必须是 ["*"] 或插件 id 列表');
  }
  if (o.classes !== undefined) {
    if (object(o.classes)) {
      for (const [k, v] of Object.entries(o.classes)) { if (typeof v === 'boolean') p.classes[k] = v; else problems.push(`"classes.${k}" 必须是 true 或 false`); }
    } else problems.push('"classes" 必须是 { "<class>": true | false }');
  }
  if (o.limits !== undefined) {
    const n = object(o.limits) ? o.limits.maxSets : undefined;
    if (n !== undefined) { if (Number.isInteger(n) && n >= 0 && n <= 64) p.maxSets = n; else problems.push('"limits.maxSets" 必须是 0–64 的整数'); }
  }
  if (o.allowIncompatible !== undefined) { if (typeof o.allowIncompatible === 'boolean') p.allowIncompatible = o.allowIncompatible; else problems.push('"allowIncompatible" 必须是 true 或 false'); }
  const holds = object(o.hold) ? o.hold : {};
  const allowDownloadHosts = Array.isArray(o.allowDownloadHosts) && o.allowDownloadHosts.every((h) => typeof h === 'string' && h.trim()) ? o.allowDownloadHosts : [];
  if (o.allowDownloadHosts !== undefined && !allowDownloadHosts.length) problems.push('"allowDownloadHosts" 必须是主机名列表');
  const trusted = {};
  if (o.trusted !== undefined) {
    if (object(o.trusted)) {
      for (const [k, v] of Object.entries(o.trusted)) { if (isSha256(v)) trusted[k] = v; else problems.push(`"trusted.${k}" 必须是 64 位的 SHA-256 十六进制`); }
    } else problems.push('"trusted" 必须是 { "<插件 id>": "<lock 的 sha256>" }');
  }
  return { policy: p, trusted, holds, allowDownloadHosts, problems };
}

/** The policy file as it is on disk, with the engine's defaults filled in. */
export function readPolicy(dir, cfg = {}) {
  const file = path.join(dir, POLICY_REL);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  let json = null;
  let parse = [];
  if (raw !== null) { try { json = JSON.parse(raw); } catch (e) { parse = [`不是合法的 JSON（${e?.message || e}）`]; } }
  const norm = readPolicyJson(json, cfg);
  return { file, rel: POLICY_REL, exists: raw !== null, json, ...norm, problems: [...parse, ...norm.problems], hash: raw === null ? null : nodeSha256(Buffer.from(raw)) };
}

/**
 * Write the policy file, keeping every key this launcher does not manage. policy.js ignores unknown keys
 * on purpose (it is where `allowDownloadHosts` and other tools keep theirs), so a rewrite must not drop them.
 * @param {string} dir @param {Record<string, unknown>} next the managed keys to merge
 */
export function writePolicy(dir, next) {
  const file = path.join(dir, POLICY_REL);
  let current = {};
  if (fs.existsSync(file)) {
    const parsed = readJson(file);
    if (parsed === null) return { ok: false, reason: `${POLICY_REL} 不是合法 JSON，先手动修好再保存。` };
    current = parsed;
  }
  const merged = { ...current, ...next };
  const norm = readPolicyJson(merged, {});
  if (norm.problems.length) return { ok: false, reason: norm.problems.join('；') };
  const managed = { ...merged };
  const cleaned = {};
  for (const [k, v] of Object.entries(managed)) if (v !== undefined) cleaned[k] = v;
  // `limits` is a plugin-level table too: keep the keys we do not manage.
  if (object(current.limits)) cleaned.limits = { ...current.limits, ...(object(cleaned.limits) ? cleaned.limits : {}) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf8');
  return { ok: true, policy: readPolicy(dir, {}) };
}

// ------------------------------------------------------------------------------------------------
// trusted.js gates — the four reasons a script/trusted plugin is refused at boot
// ------------------------------------------------------------------------------------------------

/** trusted.js `isUnspecifiedAddress`: 0.0.0.0, :: and every spelling of them. */
export function isUnspecifiedHost(host) {
  const s = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return Number(s.split('.')[0]) === 0;
  if (!s.includes(':')) return false;
  return s.split(':').every((g) => !g || (g.includes('.') ? g.split('.').every((n) => Number(n) === 0) : parseInt(g, 16) === 0));
}

/** trusted.js `trustedHostAllowed`, minus `trusted-force`: only a literal local address passes. */
export function hostAllowedForTrusted(host) {
  const s = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const [a, b] = s.split('.').map(Number);
    const local = a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    return local && !isUnspecifiedHost(s);
  }
  if (s.includes(':')) return /^(::1|::ffff:127\.)/.test(s) || /^f[cd]/i.test(s) || /^fe[89ab]/i.test(s);
  return false; // a hostname is not an address: the engine refuses it too
}

/**
 * The gates `trustDecision` applies to one script/trusted plugin, in its own order, each with the code the
 * engine would report (and its own Chinese text).
 * @param {{ shape: object, mode: string, host: string, trusted?: Record<string,string>, locked?: boolean, pinned?: string | null, hash?: string | null }} a
 */
export function trustGates({ shape, mode, host, trusted = {}, locked = false, hash = null }) {
  const isTrusted = shape.cls === 'trusted';
  const pin = trusted[shape.id] || null;
  const pinned = !!hash && pin === hash;
  // trusted.js `trustDecision`, step for step: sandbox only ever covers the sandboxable `script` class and
  // needs no pin; every other accepting mode passes the public-address gate and then the pin.
  const trustedMode = ['trusted', 'trusted-force'].includes(mode);
  const modeOk = trustedMode || (mode === 'sandbox' && !isTrusted);
  const hostOk = !trustedMode || mode === 'trusted-force' || hostAllowedForTrusted(host);
  const needsPin = trustedMode;
  const pinOk = needsPin ? locked && pinned : locked;
  const gates = [
    {
      id: 'mode', ok: modeOk, code: 'PLUGIN_SCRIPTS_DISABLED',
      label: '启动模式允许这类插件',
      detail: modeOk
        ? `SP_PLUGIN_SCRIPTS=${mode}`
        : isTrusted
          ? `SP_PLUGIN_SCRIPTS=${mode || 'off'}：受信任插件需要 trusted 或 trusted-force（off 与 sandbox 都不行）`
          : `SP_PLUGIN_SCRIPTS=${mode || 'off'}：脚本插件需要 sandbox、trusted 或 trusted-force`,
    },
    {
      id: 'host', ok: hostOk, code: 'PLUGIN_TRUST_PUBLIC',
      label: '监听地址不是公网',
      detail: trustedMode
        ? mode === 'trusted-force' ? `监听 ${host}，trusted-force 已显式允许`
          : hostAllowedForTrusted(host) ? `监听 ${host}`
            : `监听 ${host} 属于公网或未指定地址，会被拒；改为 127.0.0.1 或局域网地址，或显式用 trusted-force`
        : mode === 'sandbox' ? 'sandbox 只看 lock，不看监听地址'
          : '没有启用脚本插件，这一条不适用',
    },
    {
      id: 'pin', ok: pinOk, code: 'PLUGIN_TRUST_PIN',
      label: needsPin ? 'lock 有效且哈希已钉住' : 'lock 有效',
      detail: !locked ? 'lock 无效或文件已改变：重新打包'
        : !needsPin ? (mode === 'sandbox' ? 'sandbox 只要求 lock 有效，不需要钉住' : '没有启用受信任模式，这一条不适用')
          : pinned ? `已钉住 ${String(hash).slice(0, 12)}…`
            : pin ? `钉住的哈希与当前 lock 不符（当前 ${String(hash).slice(0, 12)}…）` : '还没有钉住这个 lock 的哈希',
    },
  ];
  // trusted.js returns on the first refusal, so a gate after one that already failed is never reached:
  // mark it instead of showing a verdict the engine would never produce.
  let stopped = false;
  for (const g of gates) { if (stopped) g.after = true; else if (!g.ok) stopped = true; }
  if (shape.scope.includes('room')) {
    gates.push({ id: 'room', ok: true, code: '', label: '房间里每位真人玩家同意', detail: '房间启用时逐人确认，不由配置文件决定' });
  }
  return gates;
}

/** The mode a version would boot with, given the launcher config. */
export const modeOf = (cfg) => (SCRIPT_MODES.includes(cfg?.pluginScripts) ? cfg.pluginScripts : 'off');
