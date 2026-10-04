// launcher/lib/selfupdate.mjs — version detection and self-update for the launcher itself.
//
// The launcher lives in its own git repository (origin = this project). Two entry points use
// this module: the startup auto-update (runs before the control panel starts, so nothing is
// running yet) and the WebUI buttons. Deliberately separate from repo.mjs, which manages the
// *game* install — the two are unrelated repositories.

import path from 'node:path';
import { exists, readJson, runCapture, nowIso, compareVersions, fetchWithTimeout } from './util.mjs';
import { ROOT } from './config.mjs';
import { gitCommand, gitInfo, gitLog, gitIncoming, parseChangelog } from './repo.mjs';

const PKG = path.join(ROOT, 'package.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

/**
 * Non-interactive git environment. Without this a missing SSH key or a credential prompt would
 * block the launcher *before* its UI exists — the user would just see a hung console.
 */
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  GCM_INTERACTIVE: 'never',
};

const gitRun = (args, timeout = 20000) => runCapture(gitCommand(), ['-C', ROOT, ...args], { timeout, env: GIT_ENV });

/** Version declared by the launcher's own package.json. */
export const selfVersion = () => readJson(PKG, {})?.version ?? null;

export const isSelfRepo = () => exists(path.join(ROOT, '.git'));

/** Current branch of the launcher repo (falls back to master). */
export function selfBranch() {
  if (!isSelfRepo()) return 'master';
  const r = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], 8000);
  const b = r.ok ? r.out.trim() : '';
  return b && b !== 'HEAD' ? b : 'master';
}

/** Repository URL to check against: the configured one (public HTTPS by default), else `origin`. */
export function selfRemote(cfg) {
  const configured = String(cfg?.selfRepoUrl || '').trim();
  if (configured) return configured;
  if (!isSelfRepo()) return null;
  const r = gitRun(['remote', 'get-url', 'origin'], 8000);
  return r.ok && r.out ? r.out.trim() : null;
}

/** `git@github.com:owner/repo.git` / `https://github.com/owner/repo` → `https://github.com/owner/repo`. */
export function toHttpsUrl(url) {
  if (!url) return null;
  const s = String(url).trim().replace(/\.git$/, '');
  const scp = /^[^@\s]+@([^:\s]+):\/?(.+)$/.exec(s);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const http = /^https?:\/\/(.+)$/.exec(s);
  if (http) return `https://${http[1]}`;
  return null;
}

/** raw.githubusercontent base for a GitHub URL (null for non-GitHub hosts). */
export function rawBase(url, branch) {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/.exec(toHttpsUrl(url) || '');
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}/` : null;
}

/**
 * Compare the local launcher against its repository.
 * @param {object} cfg
 * @param {{deep?:boolean, quick?:boolean, log?:(line:string)=>void}} opts
 *   deep  — also fetch to list the incoming commits
 *   quick — short timeouts and no extra HTTPS lookups (used for the startup auto-update,
 *           which must never make the launcher feel like it hangs)
 */
export async function checkSelf(cfg, { deep = false, quick = false, log = () => {} } = {}) {
  const branch = selfBranch();
  const url = selfRemote(cfg);
  const out = {
    checkedAt: nowIso(),
    dir: ROOT,
    isRepo: isSelfRepo(),
    branch,
    remoteUrl: url,
    local: { version: selfVersion(), git: isSelfRepo() ? gitInfo(ROOT) : null },
    remote: null,
    updateAvailable: false,
    relation: 'unknown',   // equal | behind | ahead | diverged | unknown
    incoming: [],
    canUpdate: isSelfRepo(),
    error: null,
  };

  if (!url) {
    out.error = '没有仓库地址：启动器目录不是 git 仓库。可在「配置 → 启动器更新」里手动填写仓库地址。';
    return out;
  }
  const git = gitCommand();
  if (!git) {
    out.error = '未检测到 git，无法检测启动器更新。';
    return out;
  }

  const ls = gitRun(['ls-remote', url, `refs/heads/${branch}`], quick ? 8000 : 25000);
  if (!ls.ok || !ls.out.trim()) {
    out.error = `无法访问仓库：${(ls.out || '连接失败').split('\n')[0].slice(0, 160)}`;
    return out;
  }
  const sha = (ls.out.split(/\s+/)[0] || '').trim() || null;
  out.remote = { commit: sha, branch, version: null, source: toHttpsUrl(url) };

  const base = rawBase(url, branch);
  if (base && !quick) {
    try {
      const res = await fetchWithTimeout(`${base}package.json`, { timeout: 15000 });
      if (res.ok) out.remote.version = (await res.json())?.version ?? null;
    } catch { /* offline: commit comparison still works */ }
  }

  // "commits differ" is not the same as "we are behind": a user with local unpushed commits (or a
  // diverged branch) would otherwise be told to update forever. When the remote commit is already
  // present locally we can answer precisely; on a shallow clone we fall back to the simple compare.
  const shallow = exists(path.join(ROOT, '.git', 'shallow'));
  if (sha && out.local.git?.commit) {
    if (out.local.git.commit === sha) {
      out.relation = 'equal';
    } else if (!shallow && gitRun(['cat-file', '-e', `${sha}^{commit}`], 8000).ok) {
      const remoteInLocal = gitRun(['merge-base', '--is-ancestor', sha, 'HEAD'], 8000).ok;
      const localInRemote = gitRun(['merge-base', '--is-ancestor', 'HEAD', sha], 8000).ok;
      out.relation = remoteInLocal ? 'ahead' : localInRemote ? 'behind' : 'diverged';
    } else {
      out.relation = 'behind';   // the remote commit is not in our history → it is something new
    }
    out.updateAvailable = out.relation === 'behind';
  } else if (out.remote.version && out.local.version) {
    out.relation = compareVersions(out.remote.version, out.local.version) > 0 ? 'behind' : 'equal';
    out.updateAvailable = out.relation === 'behind';
  }

  if (deep && out.updateAvailable && out.canUpdate) {
    log(`▶ 获取远程提交列表（${branch}）…`);
    const f = gitRun(['fetch', '--no-tags', url, branch], 90000);
    if (f.ok) {
      out.incoming = gitIncoming(ROOT, 'FETCH_HEAD', 40);
      // raw.githubusercontent may be blocked; read the fetched blob instead so the remote
      // version still shows up.
      if (!out.remote.version) {
        const pv = gitRun(['show', 'FETCH_HEAD:package.json'], 10000);
        if (pv.ok) { try { out.remote.version = JSON.parse(pv.out)?.version ?? null; } catch { /* not JSON */ } }
      }
    } else {
      log(`git fetch 失败：${(f.out || '').slice(0, 200)}`);
    }
  }

  if (out.updateAvailable && base && !quick) {
    try {
      const res = await fetchWithTimeout(`${base}CHANGELOG.md`, { timeout: 15000 });
      if (res.ok) {
        const { parseChangelogText } = await import('./version.mjs');
        const sections = parseChangelogText(await res.text());
        const newer = sections.filter((s) => out.local.version && compareVersions(s.version, out.local.version) > 0);
        out.remoteChangelog = newer.length ? newer : sections.slice(0, 1);
      }
    } catch { /* optional */ }
  }
  return out;
}

/** Fast-forward the launcher to the repository's branch. Throws with a readable reason. */
export async function applySelf(cfg, { force = false, log = () => {} } = {}) {
  const url = selfRemote(cfg);
  if (!url) throw new Error('没有配置启动器仓库地址。');
  if (!isSelfRepo()) throw new Error('启动器目录不是 git 仓库，无法自动更新；请改用 git clone 获取启动器。');
  if (!gitCommand()) throw new Error('未检测到 git。');
  const branch = selfBranch();

  log(`▶ git fetch ${url}（${branch}）`);
  const f = gitRun(['fetch', '--no-tags', url, branch], 180000);
  if (!f.ok) throw new Error(`git fetch 失败：${(f.out || '连接失败').split('\n')[0].slice(0, 200)}`);

  if (force) {
    log('▶ git reset --hard FETCH_HEAD（丢弃本地修改）');
    const r = gitRun(['reset', '--hard', 'FETCH_HEAD'], 60000);
    if (!r.ok) throw new Error(`git reset 失败：${(r.out || '').slice(0, 200)}`);
  } else {
    log('▶ git merge --ff-only FETCH_HEAD');
    const r = gitRun(['merge', '--ff-only', 'FETCH_HEAD'], 60000);
    if (!r.ok) {
      // Say *which* of the two very different causes it was — "you have local edits" and
      // "your history and the remote's have diverged" need different things from the user.
      const dirty = gitRun(['status', '--porcelain'], 15000).out.trim();
      const reason = dirty ? '本地有未提交的改动' : '本地提交与远端已分叉（历史不同）';
      throw new Error(`${reason}，无法自动快进更新：\n${(r.out || '').slice(0, 300)}\n可在界面勾选「强制更新（丢弃本地修改）」后重试。`);
    }
  }
  log('✔ 启动器代码已更新');
  return { version: selfVersion(), git: gitInfo(ROOT) };
}

/** Local history of the launcher itself (changelog sections + recent commits). */
export function selfHistory() {
  return {
    changelog: exists(CHANGELOG) ? parseChangelog(ROOT) : [],
    commits: gitLog(ROOT, 20),
  };
}
