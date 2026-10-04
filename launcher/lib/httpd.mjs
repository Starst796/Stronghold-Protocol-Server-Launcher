// launcher/lib/httpd.mjs — the launcher's local control panel.
//
// A dependency-free HTTP server bound to 127.0.0.1 that serves the web UI and a small
// JSON API. Live updates (log lines, task progress, server state) are pushed to the
// browser with Server-Sent Events, so no WebSocket library is needed.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('请求体不是合法的 JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.resolve(WEB_DIR, rel);
  if (!full.startsWith(WEB_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/**
 * @param {{getState:()=>object, actions:Record<string, Function>, logStore:object, bus:object}} deps
 * @returns {http.Server}
 */
export function createHttpServer({ getState, actions, logStore, bus }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    try {
      if (pathname === '/api/events') return sse(req, res, { getState, logStore, bus });
      if (pathname.startsWith('/api/')) return await api(req, res, url, { getState, actions, logStore });
      return serveStatic(res, pathname);
    } catch (e) {
      sendJson(res, 500, { error: String(e?.message || e) });
    }
  });
  server.on('clientError', (_e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ } });
  return server;
}

async function api(req, res, url, { getState, actions, logStore }) {
  const route = `${req.method} ${url.pathname}`;
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
  const fail = (msg, code = 400) => sendJson(res, code, { ok: false, error: msg });

  switch (route) {
    case 'GET /api/state':
      return sendJson(res, 200, getState());

    case 'GET /api/logs':
      return sendJson(res, 200, { lines: logStore.list() });

    case 'POST /api/logs/clear':
      logStore.clear();
      return sendJson(res, 200, { ok: true });

    case 'POST /api/config': {
      const cfg = actions.saveConfig(body?.config || body);
      return sendJson(res, 200, { ok: true, config: cfg });
    }

    case 'POST /api/preset':
      return sendJson(res, 200, actions.applyPreset(body));

    case 'POST /api/source/test':
      return sendJson(res, 200, await actions.testSources(body?.ids));

    case 'POST /api/deploy':
      return sendJson(res, 200, await actions.deploy(body?.action || 'full'));

    case 'POST /api/task/cancel':
      return sendJson(res, 200, { ok: actions.cancelTask() });

    case 'POST /api/update':
      return sendJson(res, 200, await actions.update(body?.force === true));

    case 'POST /api/version/check':
      return sendJson(res, 200, await actions.checkVersion(body?.deep === true));

    case 'GET /api/history':
      return sendJson(res, 200, actions.getHistory());

    case 'POST /api/self/check':
      return sendJson(res, 200, await actions.checkSelf(body?.deep === true));

    case 'POST /api/self/update':
      return sendJson(res, 200, await actions.updateSelf(body?.force === true));

    case 'POST /api/self/restart':
      return sendJson(res, 200, actions.restartSelf());

    case 'GET /api/changelog':
      return sendJson(res, 200, { changelog: actions.getChangelog() });

    case 'POST /api/server/start':
      return sendJson(res, 200, await actions.serverStart());

    case 'POST /api/server/stop':
      return sendJson(res, 200, await actions.serverStop());

    case 'POST /api/server/restart':
      return sendJson(res, 200, await actions.serverRestart());

    case 'POST /api/open':
      return sendJson(res, 200, actions.open(body?.target || 'game'));

    case 'POST /api/refresh':
      return sendJson(res, 200, await actions.refresh());

    case 'POST /api/quit':
      sendJson(res, 200, { ok: true });
      setTimeout(() => actions.quit(), 200);
      return undefined;

    default:
      return fail(`未知接口：${route}`, 404);
  }
}

function sse(req, res, { getState, logStore, bus }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closing */ }
  };
  send('state', getState());
  send('logs', { lines: logStore.list() });

  const off = bus.on((evt) => {
    if (evt.type === 'log') send('log', evt.entry);
    else if (evt.type === 'task') send('task', evt.task);
    else if (evt.type === 'server') send('server', evt.server);
    else if (evt.type === 'state') send('state', evt.state);
    else if (evt.type === 'toast') send('toast', evt);
  });

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closing */ } }, 25000);
  const cleanup = () => { clearInterval(ping); off(); };
  req.on('close', cleanup);
  req.on('error', cleanup);
  return undefined;
}
