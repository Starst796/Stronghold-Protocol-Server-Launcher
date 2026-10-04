// launcher/lib/game.mjs — start / stop / supervise the game's Node server process.
//
// The server is the project's own `server/index.js`, launched with the environment
// variables from the config (PORT / HOST / SP_COMBAT / SP_VERIFY / TRUST_PROXY / DEBUG).
// Its stdout & stderr are forwarded to the terminal page, and `GET /healthz` is polled
// so the UI can show "starting → running" instead of guessing.

import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { exists, killTree, openExternal, sleep, fetchWithTimeout, localAddresses } from './util.mjs';
import { serverEnv } from './config.mjs';
import { gameDir } from './repo.mjs';

/** Try to TCP-connect to a port. */
export function probePort(port, host = '127.0.0.1', timeout = 900) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (listening) => { socket.destroy(); resolve(listening); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Is the thing answering on this port our game server? Returns its /healthz JSON or null. */
export async function probeHealth(port, timeout = 1500) {
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/healthz`, { timeout });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.ok ? json : null;
  } catch {
    return null;
  }
}

export class GameServer {
  /**
   * @param {{log:(entry:{channel:string,stream:string,line:string})=>void,
   *          onEvent?:(evt:object)=>void, getConfig:()=>object}} deps
   */
  constructor({ log, onEvent, getConfig }) {
    this.log = log;
    this.onEvent = onEvent || (() => {});
    this.getConfig = getConfig;
    this.child = null;
    this.state = {
      status: 'idle',          // idle | starting | running | stopping | external | error
      pid: null,
      port: null,
      url: null,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      health: null,
      error: null,
      external: false,
    };
  }

  #patch(patch) {
    this.state = { ...this.state, ...patch };
    this.onEvent({ type: 'server', server: this.state });
  }

  get running() { return ['running', 'external'].includes(this.state.status); }
  get busy() { return ['starting', 'stopping'].includes(this.state.status); }

  /** Refresh health info while running. */
  async refreshHealth() {
    const cfg = this.getConfig();
    if (!this.running) return;
    const health = await probeHealth(cfg.port);
    if (health) {
      this.#patch({ health, status: this.state.external ? 'external' : 'running' });
    } else if (this.state.status === 'running') {
      this.#patch({ health: null });
    }
  }

  /**
   * Start the server.
   * @param {{openBrowser?:boolean}} opts
   */
  async start({ openBrowser } = {}) {
    if (this.running) return { ok: true, already: true };
    if (this.busy) return { ok: false, error: '正在处理中，请稍候' };
    const cfg = this.getConfig();
    const dir = gameDir(cfg);
    const entry = path.join(dir, 'server', 'index.js');
    if (!exists(path.join(dir, 'package.json'))) {
      return this.#fail('尚未部署游戏，请先在「主界面」点击「一键部署」。');
    }
    if (!exists(entry)) return this.#fail(`找不到服务器入口：${entry}`);

    this.#patch({ status: 'starting', error: null, port: cfg.port, url: `http://localhost:${cfg.port}`, startedAt: Date.now(), endedAt: null, exitCode: null, external: false, health: null });
    this.log({ channel: 'server', stream: 'meta', line: `▶ 正在启动服务器（端口 ${cfg.port}）…` });

    if (await probePort(cfg.port)) {
      const health = await probeHealth(cfg.port);
      if (health) {
        this.log({ channel: 'server', stream: 'meta', line: `端口 ${cfg.port} 上已经有本项目的服务器在运行，直接接入（日志由外部终端输出）。` });
        this.#patch({ status: 'external', external: true, pid: null, health, startedAt: Date.now() });
        if (openBrowser ?? cfg.openBrowser) openExternal(`http://localhost:${cfg.port}`);
        return { ok: true, external: true };
      }
      return this.#fail(`端口 ${cfg.port} 已被其他程序占用，请在「配置」里换一个端口。`);
    }

    const env = { ...process.env, ...serverEnv(cfg) };
    const child = spawn(process.execPath, [entry], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.#patch({ pid: child.pid });

    const emit = (stream) => {
      let buf = '';
      return (chunk) => {
        buf += chunk.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.length) this.log({ channel: 'server', stream, line });
        }
        if (buf.length > 64 * 1024) { this.log({ channel: 'server', stream, line: buf }); buf = ''; }
      };
    };
    child.stdout?.on('data', emit('stdout'));
    child.stderr?.on('data', emit('stderr'));

    let exited = false;
    child.on('exit', (code, signal) => {
      exited = true;
      this.child = null;
      const wasStopping = this.state.status === 'stopping';
      this.log({ channel: 'server', stream: 'meta', line: wasStopping ? '服务器已停止。' : `服务器进程退出（退出码 ${code ?? signal ?? '?'}）。` });
      this.#patch({
        status: wasStopping ? 'idle' : (code === 0 ? 'idle' : 'error'),
        pid: null, endedAt: Date.now(), exitCode: code ?? null, health: null,
        error: wasStopping || code === 0 ? null : `服务器异常退出（退出码 ${code ?? signal ?? '?'}），请查看「终端」页的日志。`,
      });
    });
    child.on('error', (e) => {
      this.log({ channel: 'server', stream: 'stderr', line: `启动失败：${e.message}` });
      this.#patch({ status: 'error', error: e.message, pid: null });
    });

    // Wait for /healthz so "starting" turns into "running" only when it really is.
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && !exited) {
      const health = await probeHealth(cfg.port);
      if (health) {
        this.#patch({ status: 'running', health, error: null });
        this.log({ channel: 'server', stream: 'meta', line: `✔ 服务器已就绪：http://localhost:${cfg.port}` });
        for (const a of localAddresses().filter((x) => x.kind === 'lan')) {
          this.log({ channel: 'server', stream: 'meta', line: `   局域网：http://${a.address}:${cfg.port}（${a.iface}）` });
        }
        if (openBrowser ?? cfg.openBrowser) openExternal(`http://localhost:${cfg.port}`);
        return { ok: true };
      }
      await sleep(400);
    }
    if (!exited) return this.#fail('服务器启动超时（40 秒内 /healthz 无响应），请查看「终端」页的日志。');
    return { ok: false, error: this.state.error || '服务器启动失败' };
  }

  #fail(message) {
    this.log({ channel: 'server', stream: 'stderr', line: message });
    this.#patch({ status: 'error', error: message, pid: null, endedAt: Date.now() });
    return { ok: false, error: message };
  }

  /** Stop the server (SIGTERM, then a hard kill if it lingers). */
  async stop() {
    if (!this.running) return { ok: true, already: true };
    if (this.state.external) {
      this.log({ channel: 'server', stream: 'meta', line: '服务器由外部启动，启动器无法停止它；请在原终端按 Ctrl+C。' });
      this.#patch({ status: 'idle', external: false, health: null, pid: null });
      return { ok: false, error: '外部启动的服务器需要手动停止' };
    }
    const child = this.child;
    if (!child || !child.pid) {
      this.#patch({ status: 'idle', health: null, pid: null });
      return { ok: true };
    }
    this.#patch({ status: 'stopping' });
    this.log({ channel: 'server', stream: 'meta', line: '正在停止服务器…' });
    killTree(child.pid, 'SIGTERM');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && this.child === child) await sleep(200);
    if (this.child === child) {
      this.log({ channel: 'server', stream: 'meta', line: '服务器未在 8 秒内退出，强制结束进程。' });
      killTree(child.pid, 'SIGKILL');
      await sleep(500);
    }
    if (this.state.status === 'stopping') this.#patch({ status: 'idle', pid: null, health: null, endedAt: Date.now() });
    return { ok: true };
  }

  async restart(opts) {
    await this.stop();
    await sleep(300);
    return this.start(opts);
  }

  /** URLs to share, based on the configured host. */
  shareUrls() {
    const cfg = this.getConfig();
    const out = [];
    if (cfg.host === '0.0.0.0' || cfg.host === '::') {
      for (const a of localAddresses()) {
        if (a.kind !== 'lan') continue;
        out.push({ url: `http://${a.address}:${cfg.port}`, label: a.iface });
      }
    }
    return out;
  }

  /** Kill the server on launcher shutdown. */
  dispose() {
    if (this.child?.pid) killTree(this.child.pid, 'SIGTERM');
  }
}
