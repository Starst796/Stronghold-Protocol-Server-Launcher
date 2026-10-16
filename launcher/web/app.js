// launcher/web/app.js — the launcher's front end. Plain ES modules, no framework:
// it talks to the Node control panel over a tiny JSON API and receives live log lines
// and state changes through an SSE stream.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Launcher state, refreshed from the server. */
let S = null;
let configDirty = false;
let history = { changelog: [], commits: [] };

// Non-blocking "git not found" notice — dismissed for this browser once the user opts out.
const GIT_NOTICE_KEY = 'sp.gitNotice.dismissed';
let gitNoticeRendered = null;

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

// ------------------------------------------------------------------ Markdown (changelog)
// The update history is Markdown (headings, lists, links, `code`, **bold**). Rendering it as
// raw text made the announcements unreadable, so a small, strictly-escaping renderer keeps it
// legible. Everything is HTML-escaped first — the text comes from a git repository.

function mdInline(text) {
  const codes = [];
  let s = escapeHtml(text).replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const safe = /^(https?:|#|\/)/i.test(href) ? href : null;
    return safe ? `<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>` : label;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

/** Minimal Markdown → HTML: headings, ordered/unordered lists, rules, paragraphs, inline spans. */
function renderMarkdown(md) {
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of String(md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); closeList(); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); closeList();
      out.push(`<h${heading[1].length}>${mdInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const want = bullet ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${mdInline((bullet || numbered)[1])}</li>`);
      continue;
    }
    if (list) closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return out.join('\n');
}

// ------------------------------------------------------------------ navigation
const PAGE_TITLES = { home: '主界面', config: '配置', versions: '版本', modsource: 'mod 源', terminal: '终端', about: '关于' };
let currentPage = 'home';

function setPage(page) {
  currentPage = page;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  $('#page-title').textContent = PAGE_TITLES[page] || page;
  if (page === 'terminal') scrollTermToEnd(true);
  if (page === 'versions') ensureReleases();
  if (page === 'modsource') ensureModSource();
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
  if (S.self?.updateReady) $('#side-meta').textContent += ' · 待重启生效';
  else if (S.self?.updateAvailable) $('#side-meta').textContent += ' · 有新版本';

  const badgeServer = $('#badge-server');
  badgeServer.textContent = SERVER_LABEL[server.status] || server.status;
  badgeServer.className = `badge badge-server ${['running', 'external'].includes(server.status) ? 'on' : 'off'}`;

  const installed = S.install.hasPackageJson;
  $('#badge-version').textContent = installed ? `游戏 v${version.local?.version ?? S.install.packageVersion ?? '?'}` : '未部署';

  // The update axis is per version now (each has its own repository), so the badge counts versions
  // with new commits rather than comparing the install against one download source.
  const bu = $('#badge-update');
  const updatable = (S.installs || []).filter((v) => v.check?.state === 'behind');
  const diverged = (S.installs || []).filter((v) => v.check?.state === 'diverged');
  if (updatable.length || diverged.length) {
    bu.hidden = false;
    bu.className = 'badge badge-warn';
    bu.textContent = updatable.length ? `${updatable.length} 个版本可更新` : `${diverged.length} 个版本已分叉`;
    bu.title = '点击查看「版本」页';
  } else if (S.checkingInstalls) {
    bu.hidden = false;
    bu.className = 'badge';
    bu.textContent = '检查更新中…';
  } else {
    bu.hidden = true;
  }

  const navTask = $('#nav-task');
  navTask.hidden = task.status !== 'running';

  // Which version is selected, so the top bar always says what "启动" would run.
  const activeVer = (S.installs || []).find((v) => v.id === S.activeInstallId) || null;
  const badgeVer = $('#badge-version-label');
  if (badgeVer) {
    badgeVer.hidden = !activeVer;
    if (activeVer) {
      badgeVer.textContent = activeVer.label;
      badgeVer.title = `${activeVer.dir}${activeVer.repo ? `\n${activeVer.repo} @ ${activeVer.ref}` : ''}`;
    }
  }
  const navVer = $('#nav-versions');
  if (navVer) {
    const n = (S.installs || []).length;
    navVer.hidden = n < 1;
    navVer.textContent = String(n);
  }
}

// ------------------------------------------------------------------ render: home
function renderGitNotice() {
  const el = $('#git-notice');
  if (!el) return;
  const launcher = S.launcher || {};
  let dismissed = false;
  try { dismissed = localStorage.getItem(GIT_NOTICE_KEY) === '1'; } catch { /* private mode */ }
  const show = !launcher.hasGit && !dismissed;
  el.hidden = !show;
  if (!show) { gitNoticeRendered = null; return; }

  const hint = launcher.gitInstall || {};
  const cmds = hint.commands || [];
  const primary = cmds[0];
  const detail = primary
    ? `游戏仍可用压缩包方式部署，但启动器无法自动更新。安装 git 即可开启自更新，例如 <code>${escapeHtml(primary.cmd)}</code>。`
    : '游戏仍可用压缩包方式部署，但启动器无法自动更新。安装 git 后即可开启自更新。';
  if (detail !== gitNoticeRendered) {
    $('#git-notice-detail').innerHTML = detail;
    gitNoticeRendered = detail;
  }
  el.dataset.cmd = cmds.map((c) => c.cmd).join('\n');
  el.dataset.url = hint.url || 'https://git-scm.com/downloads';
}

function renderHome() {
  const { install, server, task, version, config, launcher } = S;

  const local = install.local || {};
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
    ['本地客户端素材', !install.hasPackageJson ? '—'
      : (local.manifest
        ? `已提取 ${local.count} 项${local.board3d ? '，3D 棋盘可用' : ''}`
        : (S.config.extractLocal ? '未提取（有客户端时部署会自动提取）' : '未提取（已在配置里关闭）')),
      local.manifest && local.board3d ? 'ok' : ''],
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
  if (install.hasPackageJson && !launcher.hasGit) hints.push('未检测到 git：仍可用压缩包方式部署，但启动器无法自动更新；安装 git 后即可开启自更新。');
  if (install.hasPackageJson && !launcher.hasNpm) hints.push('未检测到 npm：无法安装依赖，请先安装 Node.js（含 npm）。');
  if (install.hasPackageJson && install.local && !install.local.manifest && S.config.extractLocal) {
    hints.push('本地客户端素材未提取：装了《明日方舟》客户端的话，可在「配置 → 本地客户端素材」指定目录后点「重新提取」，即可启用官方 3D 棋盘与部分官方图标。');
  }
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


  // Share list
  const share = server.status === 'running' || server.status === 'external' ? S.network.share : [];
  $('#share-list').innerHTML = share.length
    ? share.map((s) => `<div class="share-item"><span class="url">${escapeHtml(s.url)}</span><span class="iface">${escapeHtml(s.label)}</span><button class="btn ghost sm copy" data-copy="${escapeHtml(s.url)}">复制</button></div>`).join('')
    : '<p class="fine">启动服务器后，这里会列出局域网地址，可直接发给朋友。</p>';
}

// ------------------------------------------------------------------ render: history
function entryHtml(version, date, bodyHtml, open) {
  return `<details class="entry"${open ? ' open' : ''}>
      <summary><span class="ver">${version}</span>${date ? `<span class="date">${date}</span>` : ''}</summary>
      <div class="body md">${bodyHtml}</div>
    </details>`;
}

function commitsHtml(commits, label = '最近提交') {
  if (!commits.length) return '';
  return `<details class="entry">
      <summary><span class="ver">${escapeHtml(label)}（${commits.length}）</span></summary>
      <div class="body commit-list">${commits.map((c) => `<div class="commit"><span class="hash">${escapeHtml(c.hash)}</span><span>${escapeHtml(c.subject)}</span><span class="cdate">${escapeHtml(c.date || '')}</span></div>`).join('')}</div>
    </details>`;
}

function changelogHtml(sections, limit = 12) {
  return sections.slice(0, limit)
    .map((c, i) => entryHtml(`v${escapeHtml(c.version)}`, escapeHtml(c.date || ''), renderMarkdown(c.body), i === 0))
    .join('');
}

function renderHistory() {
  const game = { changelog: history.changelog || [], commits: history.commits || [] };
  const self = history.self || { changelog: [], commits: [] };

  const gameHtml = changelogHtml(game.changelog) + commitsHtml(game.commits);
  $('#history').innerHTML = gameHtml || '<p class="fine">部署完成后这里会显示版本更新历史（来自 CHANGELOG.md 与 git 提交记录）。</p>';

  const selfHtml = changelogHtml(self.changelog, 20) + commitsHtml(self.commits, '启动器最近提交');
  $('#about-changelog').innerHTML = gameHtml || '<p class="fine">还没有更新历史。</p>';
  $('#about-self-changelog').innerHTML = selfHtml || '<p class="fine">启动器还没有更新历史记录。</p>';
}

async function loadHistory() {
  try { history = await api('/api/history'); renderHistory(); renderSelfIncoming(); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ render: launcher self-update
const SELF_RELATION = {
  equal: '与远端一致',
  behind: '远端有新版本',
  ahead: '本地领先于远端（有未推送的提交）',
  diverged: '本地与远端已分叉',
  unknown: '',
};

function renderSelfIncoming() {
  const el = $('#self-incoming');
  if (!el) return;
  const self = (S && S.self) || {};
  const parts = [];
  if (self.error) {
    parts.push(`<p class="fine">${escapeHtml(self.error)}</p>`);
  } else if (self.updateAvailable) {
    if (self.remoteChangelog?.length) {
      parts.push('<p class="fine">新版本内容：</p>'
        + self.remoteChangelog.map((c) => `<div class="md">${renderMarkdown(c.body)}</div>`).join(''));
    }
    if (self.incoming?.length) {
      parts.push(`<p class="fine">待更新的提交（${self.incoming.length}）：</p><ul class="commit-list">`
        + self.incoming.slice(0, 30).map((c) => `<li class="commit"><span class="hash">${escapeHtml(c.hash)}</span><span>${escapeHtml(c.subject)}</span><span class="cdate">${escapeHtml(c.date || '')}</span></li>`).join('')
        + '</ul>');
    }
    if (!self.incoming?.length && !self.remoteChangelog?.length) {
      parts.push('<p class="fine">有新版本可用，点「更新启动器」即可拉取。</p>');
    }
  } else if (self.relation === 'ahead') {
    parts.push('<p class="fine">本地提交比远端新（你自己改过或还没 push），不需要更新。</p>');
  } else if (self.relation === 'diverged') {
    parts.push('<p class="fine">本地与远端各自有独立的提交，无法自动快进。需要时可在本地 <code>git pull --rebase</code>，或勾选「强制更新（丢弃本地修改）」覆盖为远端版本。</p>');
  } else if (self.checkedAt) {
    parts.push('<p class="fine">当前已是最新版本。</p>');
  }
  el.innerHTML = parts.join('');
}

function renderSelf() {
  const self = (S && S.self) || {};
  const lv = self.local?.version ?? S?.launcher?.version ?? '?';
  const rv = self.remote?.version;

  $('#self-row').innerHTML = [
    ['当前版本', `v${lv}`],
    ['远端版本', rv ? `v${rv}` : (self.error ? '获取失败' : '—')],
    ['当前提交', self.local?.git?.short ? `${self.local.git.short}${self.local.git.dirty ? '（有本地修改）' : ''}` : '—'],
    ['同步状态', SELF_RELATION[self.relation] || '—'],
    ['最近检查', self.checkedAt ? new Date(self.checkedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未检查'],
  ].map(([k, v]) => `<div class="status-item"><span class="k">${escapeHtml(k)}</span><span class="v mono">${escapeHtml(String(v))}</span></div>`).join('');

  const repo = $('#self-repo');
  if (!self.isRepo) {
    repo.textContent = `启动器目录不是 git 仓库，无法自动更新（请重新下载整合包）。${self.remoteUrl ? `仓库：${self.remoteUrl}` : ''}`;
  } else {
    repo.textContent = `仓库：${self.remoteUrl || '未配置'} · 分支 ${self.branch || 'master'}`
      + (S?.config?.autoUpdateSelf ? ' · 启动时自动更新：开' : ' · 启动时自动更新：关');
  }

  const busy = S.task.status === 'running';
  $('#btn-self-update').hidden = !(self.updateAvailable && self.canUpdate) || busy;
  $('#btn-self-restart').hidden = !self.updateReady;
  $('#card-self')?.classList.toggle('highlight', !!(self.updateAvailable && !self.updateReady) || self.updateReady);
  renderSelfIncoming();
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
  $('#cfg-auto-self').checked = !!c.autoUpdateSelf;
  $('#cfg-self-repo').value = c.selfRepoUrl || '';
  $('#cfg-share-assets').checked = c.shareAssets !== false;
  $('#cfg-shared-dir').value = c.sharedAssetsDir || '';
  $('#cfg-client-dir').value = c.clientDir || '';
  $('#cfg-extract-local').checked = !!c.extractLocal;
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

// ------------------------------------------------------------------ render: versions
/** One version, as a card with the actions that make sense for its state. */
function versionCard(v, { active }) {
  const busy = S.task.status === 'running';
  const running = ['running', 'external'].includes(S.server.status);
  const isActive = active && S.activeInstallId === v.id;
  const linkLabel = { symlink: '共享素材（符号链接）', junction: '共享素材（目录联接）', copy: '共享素材（复制）', own: '素材未共享', skipped: '素材未共享（已关闭共享）' }[v.linkMode] || '';
  const chk = v.check;
  const CHECK_LABEL = {
    equal: '已是最新', behind: `可更新（${chk?.incoming?.length || '?'} 个新提交）`, ahead: '本地领先远端',
    diverged: '与远端分叉', norepo: '无来源仓库', unknown: '未检查',
  };
  const checkLabel = chk ? (CHECK_LABEL[chk.state] || chk.state) : null;
  const notes = [];
  if (v.repo) notes.push(v.repo.replace(/\.git$/, ''));
  if (v.ref) notes.push(`分支 ${v.ref}`);
  if (v.commit) notes.push(v.commit.slice(0, 8));
  if (checkLabel) notes.push(checkLabel);
  if (v.sizeBytes) notes.push(fmtBytes(v.sizeBytes));
  if (linkLabel) notes.push(linkLabel);
  const warn = [];
  if (!v.exists) warn.push('目录不存在');
  else if (!v.packageVersion) warn.push('缺少 package.json');
  if (v.exists && !v.hasNodeModules) warn.push('依赖未安装');
  if (v.exists && !v.assetsPresent) warn.push('素材未下载');
  const cls = ['mod-card', isActive ? 'on' : '', v.exists ? '' : 'off'].filter(Boolean).join(' ');
  const actions = v.exists
    ? `<button class="btn ghost sm" data-ver-activate="${escapeHtml(v.id)}"${isActive || running || busy ? ' disabled' : ''}>${isActive ? '当前版本' : '设为当前'}</button>
       <button class="btn ${chk?.state === 'behind' || chk?.state === 'diverged' ? 'primary' : 'ghost'} sm" data-ver-update="${escapeHtml(v.id)}"${running || busy ? ' disabled' : ''}>${chk?.state === 'behind' ? '更新到最新' : '更新'}</button>
       <button class="btn ghost sm" data-ver-open="${escapeHtml(v.id)}">打开目录</button>
       <button class="btn ghost sm danger-ghost" data-ver-remove="${escapeHtml(v.id)}"${isActive && running ? ' disabled' : ''}>删除</button>`
    : `<button class="btn ghost sm" data-ver-update="${escapeHtml(v.id)}"${busy ? ' disabled' : ''}>重新安装</button>
       <button class="btn ghost sm danger-ghost" data-ver-remove="${escapeHtml(v.id)}"${busy ? ' disabled' : ''}>移除记录</button>`;
  return `<div class="${cls}">
      <span class="mod-check" aria-hidden="true"></span>
      <span class="mod-text">
        <b>${escapeHtml(v.label)}<em class="mod-kind">${v.kind === 'upstream' ? '原版' : 'fork'}</em>${isActive ? '<em class="mod-kind">当前</em>' : ''}</b>
        ${notes.length ? `<small>${escapeHtml(notes.join(' · '))}</small>` : ''}
        ${warn.length ? `<small class="mod-notes">${escapeHtml(warn.join('、'))}</small>` : ''}
        <span class="ver-actions">${actions}</span>
      </span>
    </div>`;
}

function renderVersions() {
  if (!$('#version-list')) return;
  const list = S.installs || [];
  const active = list.find((v) => v.id === S.activeInstallId) || null;
  const busy = S.task.status === 'running';

  $('#versions-active').innerHTML = active
    ? [
      ['当前版本', active.label, ''],
      ['来源', active.repo || '（本地目录）', 'mono'],
      ['分支 / 提交', `${active.ref || '—'}${active.commit ? ` · ${active.commit.slice(0, 8)}` : ''}`, ''],
      ['目录', active.dir, 'mono'],
      ['依赖', active.hasNodeModules ? '已安装' : '未安装', active.hasNodeModules ? 'ok' : 'warn'],
      ['素材', active.assetsLinked ? '已共享（链接）' : (active.assetsPresent ? '本版本自带' : '未下载'),
        active.assetsLinked || active.assetsPresent ? 'ok' : 'warn'],
      ['占用空间', fmtBytes(active.sizeBytes), ''],
    ].map(([k, v, cls]) => `<div class="status-item"><span class="k">${escapeHtml(k)}</span><span class="v ${cls}">${escapeHtml(String(v))}</span></div>`).join('')
    : '<p class="fine">还没有登记任何版本 —— 用下面的「添加上游版本」或「添加版本（任意 fork）」开始。</p>';

  $('#version-list').innerHTML = list.length
    ? list.map((v) => versionCard(v, { active: true })).join('')
    : '<p class="fine">（空）</p>';

  const sh = S.shared || {};
  $('#shared-meta').innerHTML = [
    ['素材共享', S.config.shareAssets === false ? '已关闭' : '已开启', S.config.shareAssets === false ? 'warn' : 'ok'],
    ['共享目录', sh.publicDir || '—', 'mono'],
    ['已收纳素材', sh.populated ? `${sh.files} 个顶层项 · ${fmtBytes(sh.bytes)}` : '（还没有素材）', sh.populated ? 'ok' : 'warn'],
    ['链接方式', active?.linkMode ? ({ symlink: '符号链接', junction: '目录联接', copy: '复制', own: '未共享', skipped: '未共享' }[active.linkMode] || active.linkMode) : '—', ''],
  ].map(([k, v, cls]) => `<div class="status-item"><span class="k">${escapeHtml(k)}</span><span class="v ${cls}">${escapeHtml(String(v))}</span></div>`).join('');

  const hints = [];
  const updatable = list.filter((v) => v.check?.state === 'behind');
  if (updatable.length) {
    const first = updatable[0];
    hints.push(`${updatable.length} 个版本有新提交：${updatable.map((v) => v.label).join('、')}`
      + (first.check.incoming?.length ? `（${first.label} 的待更新提交：${first.check.incoming.slice(0, 5).map((c) => c.subject).join(' / ')}${first.check.incoming.length > 5 ? ' …' : ''}）` : ''));
  }
  const diverged = list.filter((v) => v.check?.state === 'diverged');
  if (diverged.length) hints.push(`${diverged.length} 个版本与远端分叉（${diverged.map((v) => v.label).join('、')}）：更新前需勾选「强制更新」。`);
  if (S.config.shareAssets === false) hints.push('素材共享已关闭：每个版本都会各自下载一份约 580 MB 的素材。可在「配置 → 下载与更新」开启。');
  else if (active && !active.assetsLinked && active.assetsPresent) hints.push('当前版本的素材还没有接入共享区 —— 点「重建素材链接」即可（会把已有素材收纳进共享区，不会重新下载）。');
  if (S.server.status === 'running') hints.push('服务器正在运行：切换版本或更新前请先「停止服务器」。');
  const needsSetup = list.filter((v) => !v.exists || !v.packageVersion || !v.hasNodeModules);
  if (needsSetup.length) hints.push(`${needsSetup.length} 个版本未就绪（缺目录 / 依赖 / 素材），可在其卡片上点「更新」补全。`);
  $('#versions-hint').textContent = hints.join(' ');

  $('#btn-versions-relink').disabled = busy || S.config.shareAssets === false || S.server.status === 'running';
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
  renderGitNotice();
  renderHome();
  renderSelf();
  renderConfig();
  renderVersions();
  renderReleaseList();
  renderModSource();
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
    autoUpdateSelf: $('#cfg-auto-self').checked,
    selfRepoUrl: $('#cfg-self-repo').value.trim(),
    shareAssets: $('#cfg-share-assets').checked,
    sharedAssetsDir: $('#cfg-shared-dir').value.trim(),
    clientDir: $('#cfg-client-dir').value.trim(),
    extractLocal: $('#cfg-extract-local').checked,
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
  // The home page no longer has an update card; this path is kept for the (hidden) fallback only.
  const force = $('#force-version-update')?.checked || false;
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
  try {
    const r = await api('/api/open', 'POST', { target });
    if (r && r.ok === false) toast(r.error || '打开失败', 'warn', 6000);
    else if (r && r.path) toast(`已打开：${r.path}`, 'ok', 3000);
  } catch (e) { toast(e.message, 'error'); }
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
  });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-self]');
    if (!t) return;
    const deep = t.dataset.self === 'deep';
    if (deep) setPage('terminal');
    api('/api/self/check', 'POST', { deep }).catch((err) => toast(err.message, 'error'));
  });

  $('#btn-self-update').addEventListener('click', async () => {
    const force = $('#force-self-update').checked;
    if (force && !confirm('强制更新会丢弃启动器目录里所有未提交的本地修改，确定继续？')) return;
    try {
      const r = await api('/api/self/update', 'POST', { force });
      if (r.error) toast(r.error, 'warn');
      else { toast('开始更新启动器，可在「终端」查看进度', 'ok'); setPage('terminal'); }
    } catch (e) { toast(`更新失败：${e.message}`, 'error'); }
  });

  $('#btn-self-restart').addEventListener('click', async () => {
    const running = ['running', 'external'].includes(S.server.status);
    const warn = running ? '重启启动器会同时停止正在运行的服务器（进行中的对局会结束）。\n\n确定现在重启？' : '重启启动器使更新生效？';
    if (!confirm(warn)) return;
    try { await api('/api/self/restart', 'POST'); toast('正在重启启动器…', 'ok'); } catch (e) { toast(e.message, 'error'); }
  });

  $('#badge-update').addEventListener('click', () => setPage('versions'));

  $('#modal-close').addEventListener('click', () => { $('#modal').hidden = true; });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

  $('#btn-main').addEventListener('click', () => {
    const deployed = S.install.hasPackageJson;
    doDeploy(deployed && S.install.ready ? 'repair' : 'full');
  });
  $('#btn-start').addEventListener('click', () => doServer('/api/server/start'));
  $('#btn-stop').addEventListener('click', () => doServer('/api/server/stop'));
  $('#btn-restart').addEventListener('click', () => doServer('/api/server/restart'));
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
    await saveConfig({ port: 3000, host: '0.0.0.0', combat: 'client', verify: 'off', trustProxy: 'auto', debug: false, openBrowser: true, autoStart: false, autoUpdateCheck: true, assetConcurrency: 16, installDir: '', activePreset: 'default', clientDir: '', extractLocal: true });
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

  // ---- versions page
  $('#version-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const d = btn.dataset;
    try {
      if (d.verActivate) {
        const r = await api('/api/installs/activate', 'POST', { id: d.verActivate });
        if (r.error) toast(r.error, 'warn', 7000);
      } else if (d.verUpdate) {
        const v = (S.installs || []).find((x) => x.id === d.verUpdate) || {};
        const force = $('#force-version-update').checked;
        const resync = $('#resync-version-update').checked;
        const inc = v.check?.incoming?.length || 0;
        const what = v.check?.state === 'behind'
          ? `将更新 ${inc} 个新提交`
          : (v.check?.state === 'diverged' ? '本地与远端已分叉' : '看起来已是最新');
        const warn = `更新「${v.label}」？\n\n${what}。\n`
          + `${force ? '\n⚠ 已勾选「强制更新」：该版本的本地改动会被丢弃。' : '\n（未勾选强制更新，只做快进合并）'}`
          + `${resync ? '\n已勾选「即使没有新提交也重新同步」。' : ''}`;
        if (!confirm(warn)) return;
        const r = await api('/api/installs/update', 'POST', { id: d.verUpdate, force, resync });
        if (r.error) toast(r.error, 'warn', 7000);
        else { toast('开始更新，可在「终端」查看进度', 'ok'); setPage('terminal'); }
      } else if (d.verRemove) {
        const v = (S.installs || []).find((x) => x.id === d.verRemove) || {};
        const warn = v.exists
          ? `删除版本「${v.label}」？\n\n会删除目录：\n${v.dir}\n\n共享素材不受影响。`
          : `移除记录「${v.label}」？（目录本来就不存在）`;
        if (!confirm(warn)) return;
        const r = await api('/api/installs/remove', 'POST', { id: d.verRemove });
        if (r.error) toast(r.error, 'warn', 7000);
        else { toast('已删除', 'ok'); setPage('terminal'); }
      } else if (d.verOpen) {
        const r = await api('/api/open', 'POST', { target: 'install', id: d.verOpen });
        if (r && r.ok === false) toast(r.error || '打开失败', 'warn', 6000);
      }
    } catch (err) { toast(err.message, 'error', 7000); }
  });

  $('#btn-add-version').addEventListener('click', async () => {
    const repo = $('#add-repo').value.trim();
    const ref = $('#add-ref').value.trim() || 'master';
    const label = $('#add-label').value.trim();
    if (!repo) { toast('请填写仓库地址（或用「添加上游版本」）', 'warn'); return; }
    // Warn when the shared store is empty but another version already holds the art: without adopting it
    // first, this new version downloads its own ~580 MB (measured: a duplicate full download).
    const sharedEmpty = !(S.shared?.populated);
    const withAssets = (S.installs || []).filter((v) => v.assetsPresent && !v.assetsLinked);
    const adoption = (S.config.shareAssets !== false && sharedEmpty && withAssets.length)
      ? `\n\n⚠ 共享素材区还是空的，而「${withAssets[0].label}」里已有素材。\n`
        + '建议先到「版本」页点「重建素材链接」把它收纳进共享区（移动，不重新下载），\n'
        + '否则这个新版本会重新下载约 580 MB。'
      : '';
    if (!confirm(`克隆并安装这个版本？\n\n仓库：${repo}\n分支：${ref}\n\n会下载完整源码（约 55 MB），并同步依赖；素材将复用共享区。${adoption}`)) return;
    try {
      const r = await api('/api/installs/add', 'POST', { repo, ref, label });
      if (r.error) toast(r.error, 'warn', 7000);
      else { toast('开始克隆，可在「终端」查看进度', 'ok'); setPage('terminal'); }
    } catch (e) { toast(e.message, 'error', 7000); }
  });

  $('#btn-add-upstream').addEventListener('click', async () => {
    try {
      const r = await api('/api/installs/add', 'POST', {});
      if (r.error) toast(r.error, 'warn', 7000);
      else { toast('开始安装上游版本，可在「终端」查看进度', 'ok'); setPage('terminal'); }
    } catch (e) { toast(e.message, 'error', 7000); }
  });

  $('#btn-adopt-version').addEventListener('click', async () => {
    const dir = $('#adopt-dir').value.trim();
    const label = $('#adopt-label').value.trim();
    if (!dir) { toast('请填写目录绝对路径', 'warn'); return; }
    try {
      const r = await api('/api/installs/adopt', 'POST', { dir, label });
      if (r.error) toast(r.error, 'warn', 7000);
      else { toast('已收纳为版本', 'ok'); $('#adopt-dir').value = ''; $('#adopt-label').value = ''; }
    } catch (e) { toast(e.message, 'error', 7000); }
  });

  $('#btn-versions-check').addEventListener('click', async () => {
    const btn = $('#btn-versions-check');
    btn.disabled = true;
    btn.textContent = '检查中…';
    try {
      const r = await api('/api/installs/check', 'POST', {});
      if (r.error) toast(r.error, 'warn', 7000);
      else {
        const behind = (S.installs || []).filter((v) => v.check?.state === 'behind').length;
        toast(behind ? `有 ${behind} 个版本可以更新` : '所有版本都已是最新', 'ok', 6000);
      }
    } catch (e) { toast(e.message, 'error', 7000); }
    finally { btn.disabled = false; btn.textContent = '检查更新'; }
  });

  $('#btn-versions-relink').addEventListener('click', async () => {
    if (!confirm('重建所有版本的素材链接？\n\n会把各版本已有的素材收纳进共享区（不重新下载），再建立链接。')) return;
    try {
      const r = await api('/api/installs/relink', 'POST', {});
      if (r.error) toast(r.error, 'warn', 7000);
      else toast(`已重建 ${r.count} 个版本的素材链接`, 'ok', 6000);
    } catch (e) { toast(e.message, 'error', 7000); }
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

  // ---- 版本源（Releases）
  $('#rel-source').addEventListener('change', () => { ensureReleases(); });
  $('#btn-rel-refresh').addEventListener('click', () => { ensureReleases(true); });
  $('#rel-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act="rel-install"]');
    if (!b) return;
    const tag = b.dataset.tag;
    const assetName = b.dataset.asset;
    const label = relSource()?.label || '';
    if (!confirm(`从 Release 安装 ${tag}\n\n${assetName}\n\n会下载并解压，然后设为当前版本。继续？`)) return;
    b.disabled = true;
    try {
      const r = await api('/api/installs/add-release', 'POST', { sourceId: relSourceId(), tag, assetName, label });
      if (r.started) toast('已开始安装，可在「终端」看进度', 'ok');
      else { toast(r.error || '无法安装', 'error'); b.disabled = false; }
    } catch (err) { toast(`安装失败：${err.message}`, 'error'); b.disabled = false; }
  });

  // ---- mod 源
  $('#btn-mod-refresh').addEventListener('click', () => ensureModSource(true));
  $('#mod-filters').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    modFilter = c.dataset.filter;
    $$('#mod-filters .chip').forEach((x) => x.classList.toggle('active', x === c));
    renderModSource();
  });
  $('#mod-search').addEventListener('input', (e) => { modQuery = e.target.value.trim(); renderModSource(); });
  $('#btn-mod-engine').addEventListener('click', async () => {
    try {
      const r = await api('/api/modsource/list', 'POST');
      if (!r.ok) return toast(r.error || '读取失败', 'error');
      toast(`${r.mode === 'workshop' ? '工坊包' : '插件'}清单已输出到「终端」`, 'ok');
      for (const line of (r.output || [])) termAppend({ channel: 'mods', stream: 'stdout', line });
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#mod-list').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    const id = t.dataset.id;
    try {
      if (act === 'mod-install') {
        t.disabled = true;
        const r = await api('/api/modsource/install', 'POST', { id });
        if (r.started) toast(`已开始安装 ${id}`, 'ok'); else { toast(r.error || '无法安装', 'error'); t.disabled = false; }
      } else if (act === 'mod-remove') {
        if (!confirm(`卸载 ${id}？\n\n工坊包会由引擎留一份备份（.mod-backups），插件则直接删除。`)) return;
        const r = await api('/api/modsource/remove', 'POST', { id });
        toast(r.ok ? '已卸载' : (r.error || '卸载失败'), r.ok ? 'ok' : 'error');
      } else if (act === 'mod-toggle') {
        const r = await api('/api/modsource/toggle', 'POST', { id, enabled: t.dataset.enabled === 'true' });
        toast(r.ok ? (r.enabled ? '已启用（重启服务器后生效）' : '已禁用（重启服务器后生效）') : (r.error || '切换失败'), r.ok ? 'ok' : 'error');
      }
    } catch (err) { toast(`${err.message}`, 'error'); }
  });

  // ---- git notice banner
  $('#git-notice-copy').addEventListener('click', () => {
    const el = $('#git-notice');
    const text = el.dataset.cmd || el.dataset.url || '';
    navigator.clipboard?.writeText(text).then(() => toast('已复制安装命令', 'ok'), () => toast('复制失败，请手动复制', 'warn'));
  });
  $('#git-notice-open').addEventListener('click', () => {
    window.open($('#git-notice').dataset.url, '_blank', 'noopener');
  });
  $('#git-notice-close').addEventListener('click', () => {
    try { localStorage.setItem(GIT_NOTICE_KEY, '1'); } catch { /* ignore */ }
    $('#git-notice').hidden = true;
  });

  window.addEventListener('beforeunload', () => {});
}

// ------------------------------------------------------------------ 版本源（Releases）
let relList = {};               // { [sourceId]: { releases, viaApi, error, fetchedAt } }
const relLoading = new Set();

function relSourceId() { return $('#rel-source')?.value || (S?.releaseSources?.[0]?.id ?? 'upstream'); }
function relSource() { return (S?.releaseSources || []).find((x) => x.id === relSourceId()) || null; }

/** Load one source's release list, once per session unless forced. */
async function ensureReleases(force = false) {
  const id = relSourceId();
  if (!force && relList[id]) return;
  if (relLoading.has(id)) return;
  relLoading.add(id);
  $('#rel-note').textContent = '正在读取版本列表…';
  try {
    const r = await api('/api/releases', 'POST', { sourceId: id, force });
    relList[id] = r;
    $('#rel-note').textContent = r.viaApi === false
      ? `GitHub API 不可用（${r.error || '未知原因'}），下面这份列表是按 git 标签推断的，大小未知。`
      : `共 ${r.releases.length} 个版本，读取于 ${new Date(r.fetchedAt).toLocaleTimeString()}。`;
  } catch (e) {
    $('#rel-note').textContent = `读取失败：${e.message}`;
  } finally {
    relLoading.delete(id);
    renderReleaseList();
  }
}

function renderReleaseList() {
  const host = $('#rel-list');
  if (!host) return;
  const sel = $('#rel-source');
  const sources = S?.releaseSources || [];
  if (sel && sel.options.length !== sources.length) {
    sel.innerHTML = sources.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.label)}</option>`).join('');
  }
  const src = relSource();
  const data = relList[relSourceId()];
  if (!data) {
    host.innerHTML = '<p class="fine">还没有读取版本列表 —— 点右上角「刷新列表」。</p>';
    return;
  }
  if (!data.releases?.length) {
    host.innerHTML = '<p class="fine">这个来源没有可用版本。</p>';
    return;
  }
  const busy = S.task.status === 'running';
  host.innerHTML = data.releases.map((rel) => {
    const badges = [
      `<span class="badge">${escapeHtml(rel.publishedAt ? rel.publishedAt.slice(0, 10) : '—')}</span>`,
      rel.upstream ? `<span class="badge">基于上游 ${escapeHtml(rel.upstream)}</span>` : '',
      rel.prerelease ? '<span class="badge badge-warn">预发布</span>' : '',
    ].join('');
    const usable = (rel.assets || []).filter((a) => a.usable);
    const rest = (rel.assets || []).filter((a) => !a.usable);
    const buttons = usable.map((a) => `<button class="btn primary sm" data-act="rel-install" data-tag="${escapeHtml(rel.tag)}" data-asset="${escapeHtml(a.name)}" ${busy ? 'disabled' : ''}>安装 ${escapeHtml(a.label)}${a.size ? ` · ${fmtBytes(a.size)}` : ''}</button>`).join('');
    const dim = rest.map((a) => `<span class="badge" title="${escapeHtml(a.hint)}">${escapeHtml(a.label)}（不可单独安装）</span>`).join('');
    return `<div class="src-item">
      <div class="src-main">
        <div class="src-title">${escapeHtml(rel.tag)}${badges}</div>
        <div class="src-sub">${src ? escapeHtml(src.desc) : ''}</div>
        ${rest.length ? `<div class="src-note">${dim}</div>` : ''}
        ${rel.notes ? `<details class="src-note"><summary>发布说明</summary><pre style="white-space:pre-wrap;margin:6px 0 0">${escapeHtml(rel.notes.slice(0, 1500))}</pre></details>` : ''}
      </div>
      <div class="src-actions">${buttons || '<span class="badge">没有可安装的文件</span>'}</div>
    </div>`;
  }).join('');
}

// ------------------------------------------------------------------ mod 源
let modRows = [];
let modFilter = 'all';
let modQuery = '';
let modLoading = false;
let engineListShown = false;

function modVisible(m, inst) {
  if (modFilter === 'installed' && !inst[m.id]) return false;
  if (modFilter === 'combat' && !m.combat) return false;
  if (['A', 'B', 'C'].includes(modFilter) && m.layer !== modFilter) return false;
  if (modQuery) {
    const q = modQuery.toLowerCase();
    if (!(m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))) return false;
  }
  return true;
}

async function ensureModSource(force = false) {
  if (modRows.length && !force) return;
  if (modLoading) return;
  modLoading = true;
  try {
    const r = await api('/api/modsource', 'POST', { force });
    modRows = r.rows || [];
  } catch (e) {
    toast(`读取 mod 源失败：${e.message}`, 'error');
  } finally {
    modLoading = false;
    renderModSource();
  }
}

function renderModSource() {
  const host = $('#mod-list');
  if (!host) return;
  const info = S?.modSource || {};
  const sup = S?.modSupport || {};
  const inst = S?.modInstalled || {};
  if ($('#mod-slug')) $('#mod-slug').textContent = info.slug || '';

  const pill = $('#nav-modsource');
  if (pill) {
    const n = modRows.length || info.count || 0;
    pill.hidden = !n;
    pill.textContent = n ? String(n) : '';
  }

  $('#mod-meta').innerHTML = [
    ['来源', info.label || '—', ''],
    ['条目', modRows.length ? String(modRows.length) : (info.count ?? '未读取'), ''],
    ['当前版本的支持方式', { workshop: '工坊包（原生）', plugin: '插件（经转换）', none: '不支持' }[sup.mode] || '—',
      sup.mode === 'workshop' ? 'ok' : (sup.mode === 'plugin' ? 'warn' : 'warn')],
    ['引擎版本', sup.engine || '—', ''],
    ['目录里的引擎版本', info.engine?.appVersion || '—', ''],
  ].map(([k, v, cls]) => `<div class="status-item"><span class="k">${escapeHtml(k)}</span><span class="v ${cls}">${escapeHtml(String(v))}</span></div>`).join('');

  const supEl = $('#mod-support');
  supEl.textContent = sup.reason || '';
  supEl.className = sup.mode === 'none' ? 'hint warn' : 'hint';

  if (!modRows.length) {
    host.innerHTML = `<p class="fine">${modLoading ? '正在读取目录…' : '还没有目录 —— 点右上角「刷新目录」。'}</p>`;
    return;
  }
  const busy = S.task.status === 'running';
  const rows = modRows.filter((m) => modVisible(m, inst));
  if (!rows.length) { host.innerHTML = '<p class="fine">当前筛选下没有条目。</p>'; return; }

  host.innerHTML = rows.map((m) => {
    const have = inst[m.id];
    const canInstall = sup.mode !== 'none';
    const badges = [
      `<span class="badge">v${escapeHtml(m.version)}</span>`,
      m.layer ? `<span class="badge">层 ${escapeHtml(m.layer)}</span>` : '',
      m.combat ? '<span class="badge badge-warn">改玩法</span>' : '',
      m.assetFree ? '' : '<span class="badge badge-warn">含素材</span>',
      have ? `<span class="badge badge-ok">已装（${have.mode === 'workshop' ? '工坊包' : '插件'}）</span>` : '',
      have && have.enabled === false ? '<span class="badge">已禁用</span>' : '',
    ].join('');
    const loads = m.loadErrors.length ? `<div class="src-note warn">引擎装载时报错：${escapeHtml(m.loadErrors.join('；').slice(0, 200))}</div>` : '';
    const notes = (m.notes || []).map((n) => `<div class="src-note${/⚠|超过|拒收/.test(n) ? ' warn' : ''}">${escapeHtml(n)}</div>`).join('');
    const actions = [
      have
        ? `<button class="btn ghost sm" data-act="mod-remove" data-id="${escapeHtml(m.id)}" ${busy ? 'disabled' : ''}>卸载</button>`
        : `<button class="btn primary sm" data-act="mod-install" data-id="${escapeHtml(m.id)}" ${busy || !canInstall ? 'disabled' : ''}>安装</button>`,
      (have && have.mode === 'workshop')
        ? `<button class="btn ghost sm" data-act="mod-toggle" data-id="${escapeHtml(m.id)}" data-enabled="${have.enabled === false}" ${busy ? 'disabled' : ''}>${have.enabled === false ? '启用' : '禁用'}</button>`
        : '',
    ].join('');
    return `<div class="src-item">
      <div class="src-main">
        <div class="src-title">${escapeHtml(m.name)}${badges}</div>
        <div class="src-sub">${escapeHtml(m.id)} · ${fmtBytes(m.size)} · ${m.files || '?'} 个文件</div>
        ${notes}${loads}
      </div>
      <div class="src-actions">${actions}</div>
    </div>`;
  }).join('');
}

// ------------------------------------------------------------------ boot
wire();
connect();
setInterval(loadHistory, 60000);
loadHistory();
