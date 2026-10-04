// launcher/web/app.js — the launcher's front end. Plain ES modules, no framework:
// it talks to the Node control panel over a tiny JSON API and receives live log lines
// and state changes through an SSE stream.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Launcher state, refreshed from the server. */
let S = null;
let configDirty = false;
let history = { changelog: [], commits: [] };

// ------------------------------------------------------------------ tiny API client
async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

// ------------------------------------------------------------------ ANSI → HTML
const ANSI_COLORS = {
  30: '#3d4752', 31: '#ff7b72', 32: '#3fb950', 33: '#e3b341', 34: '#79c0ff', 35: '#d2a8ff', 36: '#39c5cf', 37: '#c9d1d9',
  90: '#6e7681', 91: '#ff9e97', 92: '#7ee787', 93: '#f0d68a', 94: '#a5d6ff', 95: '#d2a8ff', 96: '#56d4dd', 97: '#f0f6fc',
};
const XTERM = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5'];

const xterm256 = (n) => {
  if (n < 16) return XTERM[n];
  if (n < 232) {
    const c = n - 16;
    const r = Math.floor(c / 36);
    const g = Math.floor((c % 36) / 6);
    const b = c % 6;
    const v = (x) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(r)},${v(g)},${v(b)})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
};

const escapeHtml = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function ansiToHtml(input, st = { fg: null, bold: false, dim: false, underline: false, inverse: false }) {
  let text = String(input)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC (window title, hyperlinks)
    .replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, '');          // CSI sequences that are not SGR
  const style = () => {
    const s = [];
    if (st.fg) s.push(`color:${st.fg}`);
    if (st.bold) s.push('font-weight:700');
    if (st.dim) s.push('opacity:.62');
    if (st.underline) s.push('text-decoration:underline');
    if (st.inverse) s.push('filter:invert(1)');
    return s.length ? `<span style="${s.join(';')}">` : '';
  };
  const wrap = (t) => { const o = style(); return o ? o + escapeHtml(t) + '</span>' : escapeHtml(t); };

  let out = '';
  let pos = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > pos) out += wrap(text.slice(pos, m.index));
    pos = re.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = { fg: null, bold: false, dim: false, underline: false, inverse: false };
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 4) st.underline = true;
      else if (c === 7) st.inverse = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 24) st.underline = false;
      else if (c === 27) st.inverse = false;
      else if (c === 39) st.fg = null;
      else if (ANSI_COLORS[c]) st.fg = ANSI_COLORS[c];
      else if (c === 38 && codes[i + 1] === 5) { st.fg = xterm256(codes[i + 2] || 0); i += 2; }
      else if (c === 38 && codes[i + 1] === 2) { st.fg = `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})`; i += 4; }
    }
  }
  if (pos < text.length) out += wrap(text.slice(pos));
  return out;
}

// ------------------------------------------------------------------ navigation
const PAGE_TITLES = { home: '主界面', config: '配置', terminal: '终端', about: '关于' };
let currentPage = 'home';

function setPage(page) {
  currentPage = page;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  $('#page-title').textContent = PAGE_TITLES[page] || page;
  if (page === 'terminal') scrollTermToEnd(true);
}

// ------------------------------------------------------------------ toasts & modal
function toast(message, level = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}

function showModal(title, body) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal').hidden = false;
}

// ------------------------------------------------------------------ formatting
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

const SERVER_LABEL = { idle: '未运行', starting: '启动中…', running: '运行中', stopping: '停止中…', external: '运行中（外部）', error: '异常' };

// ------------------------------------------------------------------ render: shell
function renderShell() {
  const { server, task, launcher, version } = S;
  const dot = $('#side-dot');
  dot.className = 'dot';
  if (task.status === 'running') { dot.classList.add('busy'); $('#side-status').textContent = `任务中：${task.label || task.kind}`; }
  else if (server.status === 'running' || server.status === 'external') { dot.classList.add('on'); $('#side-status').textContent = SERVER_LABEL[server.status]; }
  else if (server.status === 'error') { dot.classList.add('err'); $('#side-status').textContent = '服务器异常'; }
  else { $('#side-status').textContent = SERVER_LABEL[server.status] || server.status; }
  $('#side-meta').textContent = `启动器 v${launcher.version}`;

  const badgeServer = $('#badge-server');
  badgeServer.textContent = SERVER_LABEL[server.status] || server.status;
  badgeServer.className = `badge badge-server ${['running', 'external'].includes(server.status) ? 'on' : 'off'}`;

  const installed = S.install.hasPackageJson;
  $('#badge-version').textContent = installed ? `游戏 v${version.local?.version ?? S.install.packageVersion ?? '?'}` : '未部署';

  const bu = $('#badge-update');
  if (version.updateAvailable) {
    bu.hidden = false;
    bu.className = 'badge badge-warn';
    bu.textContent = `发现新版本 ${version.remote?.version ?? ''}`.trim();
    bu.title = '点击查看更新内容';
  } else if (version.checkedAt && installed) {
    bu.hidden = false;
    bu.className = 'badge badge-ok';
    bu.textContent = '已是最新';
  } else { bu.hidden = true; }

  const navTask = $('#nav-task');
  navTask.hidden = task.status !== 'running';
}

// ------------------------------------------------------------------ render: home
function renderHome() {
  const { install, server, task, version, config, launcher } = S;

  const rows = [
    ['部署状态', install.exists ? (install.hasPackageJson ? '已下载' : '目录异常') : '未下载',
      install.exists && install.hasPackageJson ? 'ok' : (install.exists ? 'err' : 'warn')],
    ['Node 依赖', install.hasNodeModules ? '已安装' : (install.hasPackageJson ? `缺少 ${install.missingPackages.join('、') || '若干'}` : '—'),
      install.hasNodeModules ? 'ok' : (install.hasPackageJson ? 'warn' : '')],
    ['前端库 vendor', install.hasVendor ? '已就绪' : (install.hasPackageJson ? `缺少 ${install.missingVendor.join('、')}` : '—'),
      install.hasVendor ? 'ok' : (install.hasPackageJson ? 'warn' : '')],
    ['美术 / 音频', !install.hasPackageJson ? '—' : (install.assets.present
      ? (install.assets.known && install.assets.missing > 0
        ? `不完整（抽查 ${install.assets.sampled} 个缺 ${install.assets.missing} 个）`
        : `已下载（清单 ${install.assets.total} 个文件）`)
      : '未下载'),
      install.hasPackageJson ? (install.assets.present && install.assets.missing === 0 ? 'ok' : 'warn') : ''],
    ['占用空间', install.exists ? fmtBytes(install.sizeBytes) : '—', ''],
    ['运行状态', SERVER_LABEL[server.status] || server.status, ['running', 'external'].includes(server.status) ? 'ok' : (server.status === 'error' ? 'err' : '')],
    ['端口', String(config.port), ''],
    ['安装目录', install.dir, 'mono'],
  ];

  $('#status-grid').innerHTML = rows.map(([k, v, cls]) =>
    `<div class="status-item"><span class="k">${escapeHtml(k)}</span><span class="v ${cls}">${escapeHtml(String(v))}</span></div>`).join('');

  // Hints
  const hints = [];
  if (!install.exists) hints.push('还没有下载游戏 —— 选择一个下载源，然后点「一键部署」。');
  else if (!install.ready) hints.push('安装不完整，点「一键部署」会自动补全依赖与素材（可中断续传）。');
  else if (install.assets.known && install.assets.missing > 0) hints.push('素材可能不完整，点「修复安装」或「只下素材」继续下载（会续传已完成的文件）。');
  if (install.hasPackageJson && !launcher.hasGit) hints.push('未检测到 git：将以压缩包方式下载，更新历史会相对有限。');
  if (install.hasPackageJson && !launcher.hasNpm) hints.push('未检测到 npm：无法安装依赖，请先安装 Node.js（含 npm）。');
  $('#deploy-hint').textContent = hints.join(' ');

  // Main / start-stop buttons
  const btnMain = $('#btn-main');
  btnMain.textContent = !install.hasPackageJson ? '一键部署' : (!install.ready ? '补全部署' : '修复安装');
  btnMain.disabled = task.status === 'running';

  const running = ['running', 'external'].includes(server.status);
  const busy = task.status === 'running' || ['starting', 'stopping'].includes(server.status);
  $('#btn-start').disabled = !install.ready || running || busy;
  $('#btn-stop').disabled = !running || busy;
  $('#btn-restart').disabled = !install.ready || busy;
  $('#btn-cancel').hidden = task.status !== 'running';
  $$('[data-deploy]').forEach((b) => { b.disabled = task.status === 'running' || (b.dataset.deploy !== 'doctor' && !install.hasPackageJson); });

  // Source select
  const sel = $('#source-select');
  if (sel.dataset.built !== '1') {
    sel.innerHTML = S.sources.map((s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join('');
    sel.dataset.built = '1';
    sel.addEventListener('change', () => saveConfig({ downloadSource: sel.value }));
  }
  sel.value = config.downloadSource;
  $('#source-desc').textContent = (S.sources.find((s) => s.id === config.downloadSource) || {}).desc || '';

  // Version card
  const vr = $('#version-row');
  const lv = version.local?.version ?? S.install.packageVersion;
  const rv = version.remote?.version;
  vr.innerHTML = [
    ['本地版本', lv ? `v${lv}` : '未安装'],
    ['远程最新', rv ? `v${rv}` : (version.error ? '获取失败' : '—')],
    ['本地提交', version.local?.git?.short ? `${version.local.git.short}${version.local.git.dirty ? '（有本地修改）' : ''}` : '—'],
    ['最近检查', version.checkedAt ? new Date(version.checkedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未检查'],
  ].map(([k, v]) => `<div class="status-item"><span class="k">${escapeHtml(k)}</span><span class="v mono">${escapeHtml(String(v))}</span></div>`).join('');

  const inc = $('#incoming');
  if (version.error) inc.innerHTML = `<p class="fine">检查失败：${escapeHtml(version.error)}（可切换下载源后重试）</p>`;
  else if (version.updateAvailable && version.incoming?.length) {
    inc.innerHTML = `<p class="fine">待更新的提交（${version.incoming.length}）：</p><ul>` +
      version.incoming.slice(0, 30).map((c) => `<li><b>${escapeHtml(c.hash)}</b> ${escapeHtml(c.subject)} <span style="color:#6b7684">${escapeHtml(c.date || '')}</span></li>`).join('') + '</ul>';
  } else if (version.updateAvailable) {
    inc.innerHTML = '<p class="fine">有新版本可用，点「立即更新」会自动拉取代码并同步依赖与素材。</p>';
  } else if (version.checkedAt && lv) inc.innerHTML = '<p class="fine">当前已是最新版本。</p>';
  else inc.innerHTML = '';

  $('#btn-update').hidden = !version.updateAvailable || task.status === 'running';

  // Share list
  const share = server.status === 'running' || server.status === 'external' ? S.network.share : [];
  $('#share-list').innerHTML = share.length
    ? share.map((s) => `<div class="share-item"><span class="url">${escapeHtml(s.url)}</span><span class="iface">${escapeHtml(s.label)}</span><button class="btn ghost sm copy" data-copy="${escapeHtml(s.url)}">复制</button></div>`).join('')
    : '<p class="fine">启动服务器后，这里会列出局域网地址，可直接发给朋友。</p>';
}

// ------------------------------------------------------------------ render: history
function renderHistory() {
  const { changelog = [], commits = [] } = history;
  const html = [];
  if (changelog.length) {
    html.push(...changelog.slice(0, 12).map((c, i) => `
      <details class="entry" ${i === 0 ? 'open' : ''}>
        <summary><span class="ver">v${escapeHtml(c.version)}</span>${c.date ? `<span class="date">${escapeHtml(c.date)}</span>` : ''}</summary>
        <div class="body">${escapeHtml(c.body)}</div>
      </details>`));
  }
  if (commits.length) {
    html.push(`<div class="entry"><summary style="cursor:default;list-style:none;padding-left:4px"><span class="ver" style="font-weight:600">最近提交（${commits.length}）</span></summary>
      <div class="body commit-list">${commits.map((c) => `<div class="commit"><span class="hash">${escapeHtml(c.hash)}</span><span>${escapeHtml(c.subject)}</span><span class="cdate">${escapeHtml(c.date || '')}</span></div>`).join('')}</div></div>`);
  }
  const out = html.length ? html.join('') : '<p class="fine">部署完成后这里会显示版本更新历史（来自 CHANGELOG.md 与 git 提交记录）。</p>';
  $('#history').innerHTML = out;
  $('#about-changelog').innerHTML = out;
}

async function loadHistory() {
  try { history = await api('/api/history'); renderHistory(); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ render: config
function renderPresets() {
  const cfg = S.config;
  $('#presets').innerHTML = S.presets.map((p) => `
    <button class="preset ${p.id === cfg.activePreset ? 'active' : ''}" data-preset="${p.id}">
      <b>${escapeHtml(p.label)}${p.custom ? ' <span class="del" data-del-preset="' + p.id + '" title="删除该预设">×</span>' : ''}</b>
      <small>${escapeHtml(p.desc || '')}</small>
    </button>`).join('');
}

function fillConfigForm() {
  const c = S.config;
  $('#cfg-port').value = c.port;
  $('#cfg-host').value = ['0.0.0.0', '127.0.0.1', '::'].includes(c.host) ? c.host : '0.0.0.0';
  $('#cfg-combat').value = c.combat;
  $('#cfg-verify').value = c.verify;
  $('#cfg-trust').value = c.trustProxy;
  $('#cfg-debug').checked = !!c.debug;
  $('#cfg-concurrency').value = c.assetConcurrency;
  $('#cfg-autocheck').checked = !!c.autoUpdateCheck;
  $('#cfg-open-browser').checked = !!c.openBrowser;
  $('#cfg-autostart').checked = !!c.autoStart;
  $('#cfg-install-dir').value = c.installDir;

  const cs = $('#cfg-source');
  if (cs.dataset.built !== '1') {
    cs.innerHTML = S.sources.map((s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join('');
    cs.dataset.built = '1';
  }
  cs.value = c.downloadSource;
}

function renderConfig() {
  renderPresets();
  if (!configDirty) fillConfigForm();
}

// ------------------------------------------------------------------ render: about
function renderAbout() {
  const { launcher, install } = S;
  $('#about-launcher-version').textContent = `v${launcher.version}`;
  $('#about-env').textContent = `Node ${launcher.node} · ${launcher.platformLabel} ${launcher.arch}`;
  $('#about-node-path').textContent = launcher.nodePath || '—';
  $('#about-root').textContent = launcher.root;
  $('#about-install').textContent = install.dir;
  $('#about-tools').textContent = `git ${launcher.hasGit ? '✔' : '✘'} · npm ${launcher.hasNpm ? '✔' : '✘'} · tar ${launcher.hasTar ? '✔' : '✘'}`;
}

// ------------------------------------------------------------------ terminal
const termLines = [];
let termFilter = 'all';
let autoScroll = true;
const MAX_DOM_LINES = 2500;

function termAppend(entry) {
  termLines.push(entry);
  if (termLines.length > 5000) termLines.splice(0, termLines.length - 5000);
  if (termFilter !== 'all' && entry.channel !== termFilter) return;
  appendDom(entry);
}

function appendDom(entry) {
  const term = $('#term');
  const empty = $('.term-empty', term);
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = `ln ${entry.stream}`;
  const label = (S?.channels?.[entry.channel]) || entry.channel;
  div.innerHTML = `<span class="ts">${fmtTime(entry.ts)}</span>` +
    `<span class="tag ${escapeHtml(entry.channel)}">${escapeHtml(label)}</span>` +
    `<span class="msg">${ansiToHtml(entry.line)}</span>`;
  term.append(div);
  while (term.childElementCount > MAX_DOM_LINES) term.firstElementChild.remove();
  if (autoScroll) scrollTermToEnd();
}

function scrollTermToEnd(force = false) {
  const term = $('#term');
  if (!term) return;
  if (force || autoScroll) term.scrollTop = term.scrollHeight;
}

function renderTerminalAll() {
  const term = $('#term');
  term.innerHTML = '';
  const list = termFilter === 'all' ? termLines : termLines.filter((l) => l.channel === termFilter);
  if (!list.length) {
    term.innerHTML = '<div class="term-empty">（暂无日志。启动部署或服务器后，这里会实时显示输出。）</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const entry of list.slice(-MAX_DOM_LINES)) {
    const div = document.createElement('div');
    div.className = `ln ${entry.stream}`;
    const label = (S?.channels?.[entry.channel]) || entry.channel;
    div.innerHTML = `<span class="ts">${fmtTime(entry.ts)}</span>` +
      `<span class="tag ${escapeHtml(entry.channel)}">${escapeHtml(label)}</span>` +
      `<span class="msg">${ansiToHtml(entry.line)}</span>`;
    frag.append(div);
  }
  term.append(frag);
  scrollTermToEnd(true);
}

function renderTaskProgress() {
  const { task } = S;
  const bar = $('#term-progress');
  if (task.status === 'running') {
    bar.hidden = false;
    const pct = task.stepTotal ? Math.round((task.stepIndex / task.stepTotal) * 100) : 0;
    $('#term-bar').style.width = `${pct}%`;
    $('#term-progress-text').textContent = `${task.label} · 第 ${task.stepIndex}/${task.stepTotal} 步：${task.step || '…'}`;
  } else {
    bar.hidden = true;
  }
}

// ------------------------------------------------------------------ master render
function render() {
  if (!S) return;
  renderShell();
  renderHome();
  renderConfig();
  renderAbout();
  renderTaskProgress();
}

// ------------------------------------------------------------------ actions
async function saveConfig(patch) {
  try {
    const r = await api('/api/config', 'POST', patch);
    S.config = r.config;
    configDirty = false;
    $('#save-msg').textContent = '已保存';
    setTimeout(() => { $('#save-msg').textContent = ''; }, 2000);
    return r.config;
  } catch (e) { toast(`保存失败：${e.message}`, 'error'); return null; }
}

function readConfigForm() {
  return {
    port: Number($('#cfg-port').value) || 3000,
    host: $('#cfg-host').value,
    combat: $('#cfg-combat').value,
    verify: $('#cfg-verify').value,
    trustProxy: $('#cfg-trust').value,
    debug: $('#cfg-debug').checked,
    assetConcurrency: Number($('#cfg-concurrency').value) || 16,
    autoUpdateCheck: $('#cfg-autocheck').checked,
    openBrowser: $('#cfg-open-browser').checked,
    autoStart: $('#cfg-autostart').checked,
    installDir: $('#cfg-install-dir').value.trim(),
  };
}

async function doDeploy(action) {
  try {
    const r = await api('/api/deploy', 'POST', { action });
    if (r.error) toast(r.error, 'warn');
    else { toast('任务已开始，可在「终端」查看进度', 'ok'); setPage('terminal'); }
  } catch (e) { toast(`启动失败：${e.message}`, 'error'); }
}

async function doUpdate() {
  const force = $('#force-update').checked;
  try {
    const r = await api('/api/update', 'POST', { force });
    if (r.error) toast(r.error, 'warn');
    else { toast('开始更新，可在「终端」查看进度', 'ok'); setPage('terminal'); }
  } catch (e) { toast(`更新失败：${e.message}`, 'error'); }
}

async function doServer(path) {
  try {
    const r = await api(path, 'POST');
    if (r && r.error) toast(r.error, 'warn');
    else toast(path.endsWith('start') ? '服务器已启动' : path.endsWith('stop') ? '服务器已停止' : '已重启', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

async function doOpen(target) {
  try { await api('/api/open', 'POST', { target }); } catch (e) { toast(e.message, 'error'); }
}

async function testSources() {
  const btn = $('#btn-test-sources');
  btn.disabled = true;
  btn.textContent = '测试中…';
  $('#source-results').innerHTML = '<li>正在逐一连接各个下载源…</li>';
  try {
    const { results } = await api('/api/source/test', 'POST', {});
    results.sort((a, b) => (b.ok - a.ok) || (a.ms - b.ms));
    $('#source-results').innerHTML = results.map((r) =>
      `<li><span class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✔' : '✘'}</span><span>${escapeHtml(r.label)}</span><span style="margin-left:auto">${r.ms} ms</span><span>${escapeHtml(r.detail || '')}</span></li>`).join('');
  } catch (e) {
    $('#source-results').innerHTML = `<li class="bad">测试失败：${escapeHtml(e.message)}</li>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连通性';
  }
}

// ------------------------------------------------------------------ SSE
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { S = JSON.parse(e.data); render(); });
  es.addEventListener('log', (e) => termAppend(JSON.parse(e.data)));
  es.addEventListener('logs', (e) => {
    const { lines } = JSON.parse(e.data);
    termLines.length = 0;
    termLines.push(...lines);
    renderTerminalAll();
  });
  es.addEventListener('task', (e) => {
    S.task = JSON.parse(e.data);
    render();
    if (S.task.status === 'done' || S.task.status === 'error' || S.task.status === 'cancelled') loadHistory();
  });
  es.addEventListener('server', (e) => { S.server = JSON.parse(e.data); render(); });
  es.addEventListener('toast', (e) => { const t = JSON.parse(e.data); toast(t.message, t.level || 'info'); });
  es.onerror = () => {
    // EventSource reconnects automatically; surface a hint if the launcher was closed.
    setTimeout(() => { if (es.readyState === EventSource.CLOSED) toast('与控制面板的连接已断开，请重启启动器。', 'error', 8000); }, 1500);
  };
}

// ------------------------------------------------------------------ wiring
function wire() {
  $('#nav').addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (item) setPage(item.dataset.page);
  });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    if (action === 'open') { e.preventDefault(); doOpen(t.dataset.target); }
    else if (action === 'refresh') api('/api/refresh', 'POST').catch(() => {});
    else if (action === 'check-update') api('/api/version/check', 'POST', { deep: false }).catch((err) => toast(err.message, 'error'));
    else if (action === 'deep-check') { api('/api/version/check', 'POST', { deep: true }).catch((err) => toast(err.message, 'error')); setPage('terminal'); }
  });

  $('#badge-update').addEventListener('click', () => {
    if (!S.version.updateAvailable) return;
    const list = (S.version.remoteChangelog || []).map((c) => `v${c.version}${c.date ? ` — ${c.date}` : ''}\n${c.body}`).join('\n\n');
    showModal(`可更新到 v${S.version.remote?.version ?? '?'}`, `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(list || '（暂无更新说明）')}</pre>`);
  });

  $('#modal-close').addEventListener('click', () => { $('#modal').hidden = true; });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

  $('#btn-main').addEventListener('click', () => {
    const deployed = S.install.hasPackageJson;
    doDeploy(deployed && S.install.ready ? 'repair' : 'full');
  });
  $('#btn-start').addEventListener('click', () => doServer('/api/server/start'));
  $('#btn-stop').addEventListener('click', () => doServer('/api/server/stop'));
  $('#btn-restart').addEventListener('click', () => doServer('/api/server/restart'));
  $('#btn-update').addEventListener('click', doUpdate);
  $('#btn-test-sources').addEventListener('click', testSources);
  $('#btn-cancel').addEventListener('click', () => api('/api/task/cancel', 'POST').catch(() => {}));
  $$('[data-deploy]').forEach((b) => b.addEventListener('click', () => doDeploy(b.dataset.deploy)));

  $('#share-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('已复制地址', 'ok'), () => toast('复制失败，请手动选择', 'warn'));
  });

  // ---- config page
  $('#page-config').addEventListener('input', (e) => { if (e.target.matches('input,select')) configDirty = true; });
  $('#btn-save-config').addEventListener('click', async () => {
    const cfg = await saveConfig(readConfigForm());
    if (cfg) toast('配置已保存', 'ok');
  });
  $('#btn-reset-config').addEventListener('click', async () => {
    if (!confirm('恢复为默认配置？')) return;
    await saveConfig({ port: 3000, host: '0.0.0.0', combat: 'client', verify: 'off', trustProxy: 'auto', debug: false, openBrowser: true, autoStart: false, autoUpdateCheck: true, assetConcurrency: 16, installDir: '', activePreset: 'default' });
    fillConfigForm();
    toast('已恢复默认配置', 'ok');
  });
  $('#presets').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-preset]');
    if (del) {
      e.stopPropagation();
      await api('/api/preset', 'POST', { delete: del.dataset.delPreset });
      return;
    }
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    const r = await api('/api/preset', 'POST', { id: btn.dataset.preset });
    S.config = r.config;
    fillConfigForm();
    toast('已应用预设', 'ok');
  });
  $('#btn-save-preset').addEventListener('click', async () => {
    const name = prompt('预设名称：', '我的预设');
    if (!name) return;
    if (configDirty) await saveConfig(readConfigForm());
    const r = await api('/api/preset', 'POST', { save: name });
    S.config = r.config;
    renderPresets();
    toast(`已保存预设「${name}」`, 'ok');
  });

  // ---- terminal page
  $('#term-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    termFilter = chip.dataset.channel;
    $$('#term-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderTerminalAll();
  });
  $('#term-autoscroll').addEventListener('change', (e) => { autoScroll = e.target.checked; });
  $('#term-clear').addEventListener('click', () => {
    termLines.length = 0;
    api('/api/logs/clear', 'POST').catch(() => {});
    renderTerminalAll();
  });
  $('#term-export').addEventListener('click', () => {
    const text = termLines.map((l) => `[${fmtTime(l.ts)}] [${l.channel}] ${l.line}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stronghold-launcher-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('#term').addEventListener('scroll', () => {
    const term = $('#term');
    const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 24;
    if (!atBottom && autoScroll) { autoScroll = false; $('#term-autoscroll').checked = false; }
  });

  window.addEventListener('beforeunload', () => {});
}

// ------------------------------------------------------------------ boot
wire();
connect();
setInterval(loadHistory, 60000);
loadHistory();
