// launcher/lib/util.mjs — small cross-platform helpers shared by the launcher.
// The launcher has no npm dependencies on purpose: it must run on a bare Node.js
// install (Node is required by the game anyway), so every helper here is built on
// the Node standard library only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Does a path exist (any type)? */
export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/** Read + parse JSON, or return `fallback` on any error. */
export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** Write JSON atomically (tmp + rename) so a crash never leaves a half-written file. */
export function writeJsonAtomic(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

export function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); return p; }

/** Return an environment with a directory prepended to PATH, preserving its key casing on Windows. */
export function prependPath(dir, env = process.env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') || 'PATH';
  return { ...env, [key]: [dir, env[key]].filter(Boolean).join(path.delimiter) };
}

/** Human-readable byte size. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Total size of a directory (best effort, used to show download progress). */
export function dirSize(dir, budget = 60000) {
  let total = 0;
  const started = Date.now();
  const walk = (d) => {
    if (Date.now() - started > budget) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { try { total += fs.statSync(full).size; } catch { /* race */ } }
    }
  };
  walk(dir);
  return total;
}

/**
 * Locate an executable on PATH (honouring PATHEXT on Windows).
 * @param {string} cmd bare name, e.g. 'git' or the full name 'npm.cmd'
 * @returns {string|null} absolute path
 */
export function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (path.isAbsolute(cmd)) return exists(cmd) ? cmd : null;
  const exts = IS_WIN ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasExt = path.extname(cmd) !== '';
  for (const dir of dirs) {
    if (hasExt) {
      const full = path.join(dir, cmd);
      if (exists(full)) return full;
      continue;
    }
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext.toLowerCase());
      if (exists(full)) return full;
      const fullUpper = path.join(dir, cmd + ext.toUpperCase());
      if (exists(fullUpper)) return fullUpper;
    }
    const bare = path.join(dir, cmd);
    if (exists(bare)) return bare;
  }
  return null;
}

export const hasCommand = (cmd) => which(cmd) !== null;

/** `npm` is a `.cmd`/shell shim on Windows; Node ≥ 18.20 refuses to spawn it without a shell. */
export function needsShell(cmd) { return IS_WIN && /\.(cmd|bat)$/i.test(cmd); }

/**
 * Run a command to completion and capture its output.
 * @returns {{ok:boolean,status:number,out:string,error?:Error}}
 */
export function runCapture(cmd, args, opts = {}) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 20000,
      cwd: opts.cwd,
      windowsHide: true,
      shell: opts.shell ?? needsShell(cmd),
      maxBuffer: 8 * 1024 * 1024,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    return { ok: !r.error && r.status === 0, status: r.status ?? -1, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error };
  } catch (e) {
    return { ok: false, status: -1, out: String(e?.message || e), error: e };
  }
}

/**
 * Stream a command's stdout/stderr line by line.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?:string,env?:object,shell?:boolean,onLine?:(stream:'stdout'|'stderr',line:string)=>void}} opts
 * @returns {{child:import('node:child_process').ChildProcess,done:Promise<{code:number,error?:Error}>,kill:(sig?:NodeJS.Signals)=>void}}
 */
export function runStream(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    windowsHide: true,
    shell: opts.shell ?? needsShell(cmd),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });

  const emit = (stream) => {
    let buf = '';
    return (chunk) => {
      buf += chunk.toString('utf8');
      // Normalise CRLF and bare CR (npm/asset progress bars redraw with \r) into separate lines.
      buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        opts.onLine?.(stream, line);
      }
      // Keep the tail bounded so a pathological stream cannot grow memory without bound.
      if (buf.length > 64 * 1024) { opts.onLine?.(stream, buf); buf = ''; }
    };
  };
  child.stdout?.on('data', emit('stdout'));
  child.stderr?.on('data', emit('stderr'));

  const done = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: -1, error }));
    child.on('close', (code) => resolve({ code: code ?? -1 }));
  });

  return {
    child,
    done,
    kill: (sig = 'SIGTERM') => { try { child.kill(sig); } catch { /* already gone */ } },
  };
}

/** Kill a process and (on Windows) its whole tree. */
export function killTree(pid, sig = 'SIGTERM') {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(pid, sig); } catch { /* gone */ }
}

/**
 * Spawn a detached, fire-and-forget helper process.
 *
 * `windowsHide` maps to CreateProcess's CREATE_NO_WINDOW. Keep it ON for console helpers
 * (rundll32, cmd) so no console window flashes — but keep it OFF when the spawned process is
 * the one that *creates the visible window*: `spawn('explorer', [dir], { windowsHide: true })`
 * yields an Explorer window that exists in the shell's window list yet is never displayed, so
 * from the user's point of view the folder simply "does not open".
 */
function spawnIgnore(cmd, args, { windowsHide = true } = {}) {
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

/** Characters cmd.exe would re-parse if we routed the path through `cmd /c start`. */
const CMD_UNSAFE = /[&^<>|%"()]/;

/** Open a URL in the user's default browser. */
export function openExternal(url) {
  if (IS_WIN) return spawnIgnore('rundll32', ['url.dll,FileProtocolHandler', url]);
  if (IS_MAC) return spawnIgnore('open', [url]);
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return spawnIgnore('xdg-open', [url]);
}

/**
 * Open a folder in the OS file manager.
 * On Windows this goes through `cmd /c start ""` so the window is both visible and brought to
 * the foreground; a bare explorer.exe ends up hidden (with windowsHide) or stays behind.
 * Paths containing cmd metacharacters fall back to explorer.exe with a visible window.
 */
export function openFolder(dir) {
  if (!exists(dir)) return false;
  if (IS_WIN) {
    if (CMD_UNSAFE.test(dir)) return spawnIgnore('explorer', [dir], { windowsHide: false });
    return spawnIgnore('cmd', ['/c', 'start', '', dir]);
  }
  if (IS_MAC) return spawnIgnore('open', [dir]);
  return spawnIgnore('xdg-open', [dir]);
}

/** LAN/loopback addresses, classified like the game's own `tools/doctor.mjs` does. */
export function localAddresses() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      const v4 = a.family === 'IPv4';
      if (!v4 && a.family !== 6) continue;
      const priv = v4 && (/^10\./.test(a.address) || /^192\.168\./.test(a.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(a.address));
      let kind = 'public';
      if (v4 && priv) kind = 'lan';
      else if (!v4 && /^fe80:/i.test(a.address)) kind = 'link';
      else if (!v4 && /^f[cd]/i.test(a.address)) kind = 'ula';
      out.push({ iface, address: a.address, family: v4 ? 'IPv4' : 'IPv6', kind });
    }
  }
  return out;
}

export const KIND_LABEL = {
  lan: '局域网', public: '公网', ula: '内网 IPv6', link: '链路本地',
};

/** Fetch with a hard timeout (Node's global fetch + AbortController). */
export async function fetchWithTimeout(url, { timeout = 12000, ...init } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: ac.signal, redirect: 'follow' });
  } finally {
    clearTimeout(t);
  }
}

/** Semver-ish compare: 1 / 0 / -1 for a > b / a === b / a < b. Tolerates a leading 'v'. */
export function compareVersions(a, b) {
  const parse = (s) => String(s ?? '').trim().replace(/^v/i, '').split(/[.-]/);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

export const nowIso = () => new Date().toISOString();

/** Normalise a filesystem path to forward slashes for display. */
export const displayPath = (p) => String(p).replace(/\\/g, '/');
