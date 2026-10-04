// launcher/lib/version.mjs — local vs. remote version, update detection and the
// update history shown on the home / about pages.
//
// Two routes are supported because direct github.com git access is blocked on some
// networks: `git ls-remote` against the selected download source, and a plain HTTPS
// fallback that reads package.json / the releases API.

import path from 'node:path';
import {
  exists, readJson, runCapture, compareVersions, fetchWithTimeout, nowIso,
} from './util.mjs';
import { sourceById, REPO_SLUG } from './config.mjs';
import { gitCommand, isGitRepo, gitInfo, gitLog, gitIncoming, parseChangelog, gameDir } from './repo.mjs';

const TAG_RE = /^\d+(?:\.\d+)*$/;

/** Version of the locally installed game (package.json), or null. */
export function localVersion(cfg) {
  const dir = gameDir(cfg);
  const pkg = readJson(path.join(dir, 'package.json'), null);
  return pkg?.version ?? null;
}

/** Parse `git ls-remote --tags --refs` output into the highest semver tag. */
export function highestTag(output) {
  let best = null;
  for (const line of String(output || '').split('\n')) {
    const ref = (line.split(/\s+/)[1] || '').trim();
    if (!ref.startsWith('refs/tags/')) continue;
    const name = ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '').replace(/^v/i, '');
    if (!TAG_RE.test(name)) continue;
    if (!best || compareVersions(name, best) > 0) best = name;
  }
  return best;
}

/** Ask the selected source what the newest release is. */
export async function remoteInfo(cfg, { log = () => {} } = {}) {
  const source = sourceById(cfg.downloadSource);
  const git = gitCommand();
  if (git) {
    const head = runCapture(git, ['ls-remote', source.git, 'refs/heads/master'], { timeout: 30000 });
    if (head.ok) {
      const commit = (head.out.split(/\s+/)[0] || '').trim() || null;
      const tags = runCapture(git, ['ls-remote', '--tags', '--refs', source.git], { timeout: 30000 });
      const tag = tags.ok ? highestTag(tags.out) : null;
      return { via: 'git', commit, tag, version: tag || null, source: source.id };
    }
    log(`ls-remote 失败：${head.out.slice(0, 200)}`);
  }
  // No git (or it failed): read the raw package.json and the releases API over HTTPS.
  try {
    const res = await fetchWithTimeout(`${source.raw}package.json`, { timeout: 20000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pkg = await res.json();
    let tag = null;
    try {
      const rel = await fetchWithTimeout(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`, {
        timeout: 15000,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sp-launcher' },
      });
      if (rel.ok) tag = String((await rel.json())?.tag_name || '').replace(/^v/i, '') || null;
    } catch { /* releases API is optional */ }
    return { via: 'https', commit: null, tag, version: pkg?.version ?? tag, source: source.id };
  } catch (e) {
    return { via: 'https', commit: null, tag: null, version: null, source: source.id, error: String(e?.message || e) };
  }
}

/** The remote CHANGELOG.md (what an update would bring), best effort. */
export async function remoteChangelog(cfg) {
  const source = sourceById(cfg.downloadSource);
  try {
    const res = await fetchWithTimeout(`${source.raw}CHANGELOG.md`, { timeout: 20000 });
    if (!res.ok) return null;
    return String(await res.text());
  } catch {
    return null;
  }
}

/** Parse a CHANGELOG.md string (same shape as parseChangelog but from memory). */
export function parseChangelogText(text) {
  const sections = [];
  const re = /^##\s+(.+?)\s*$/gm;
  let m;
  const heads = [];
  while ((m = re.exec(text)) !== null) heads.push({ title: m[1].trim(), index: m.index, end: re.lastIndex });
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].end;
    const stop = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const vm = /^([\w.\-+]+)\s*[—–-]\s*(\S+)?/.exec(heads[i].title);
    sections.push({
      version: vm ? vm[1] : heads[i].title,
      date: vm && vm[2] ? vm[2] : '',
      body: text.slice(start, stop).trim(),
    });
  }
  return sections;
}

/**
 * Full update check: local version, remote version, whether an update is available,
 * the list of incoming commits and (when there is one) what the new version contains.
 * @param {object} cfg
 * @param {{deep?:boolean, log?:(line:string)=>void}} opts deep = also `git fetch` to list incoming commits
 */
export async function checkUpdate(cfg, { deep = false, log = () => {} } = {}) {
  const dir = gameDir(cfg);
  const installed = exists(path.join(dir, 'package.json'));
  const result = {
    checkedAt: nowIso(),
    installDir: dir,
    installed,
    local: { version: localVersion(cfg), git: installed ? gitInfo(dir) : null },
    remote: null,
    updateAvailable: false,
    incoming: [],
    error: null,
  };
  if (!installed) return result;

  try {
    result.remote = await remoteInfo(cfg, { log: (l) => log(l) });
  } catch (e) {
    result.error = String(e?.message || e);
  }

  if (result.remote && !result.remote.error) {    const lv = result.local.version;
    const rv = result.remote.version;
    if (result.local.git?.commit && result.remote.commit) {
      result.updateAvailable = result.local.git.commit !== result.remote.commit
        || (!!rv && !!lv && compareVersions(rv, lv) > 0);
    } else if (rv && lv) {
      result.updateAvailable = compareVersions(rv, lv) > 0;
    }
  }

  if (deep && result.updateAvailable && result.local.git && isGitRepo(dir)) {
    const git = gitCommand();
    const source = sourceById(cfg.downloadSource);
    log(`▶ 获取远程提交列表（${source.label}）…`);
    const fetch = runCapture(git, ['-C', dir, 'fetch', '--no-tags', source.git, 'master'], { timeout: 90000 });
    if (fetch.ok) result.incoming = gitIncoming(dir, 'FETCH_HEAD');
    else log(`git fetch 失败：${fetch.out.slice(0, 200)}`);
  }

  if (result.updateAvailable && result.remote?.version) {
    const text = await remoteChangelog(cfg);
    if (text) {
      const sections = parseChangelogText(text);
      const newer = sections.filter((s) => result.local.version && compareVersions(s.version, result.local.version) > 0);
      result.remoteChangelog = (newer.length ? newer : sections.slice(0, 1));
    }
  }
  return result;
}

/** Local update history: changelog sections + recent commits. */
export function localHistory(cfg) {
  const dir = gameDir(cfg);
  return {
    changelog: parseChangelog(dir),
    commits: gitLog(dir, 40),
  };
}
