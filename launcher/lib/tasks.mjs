// launcher/lib/tasks.mjs — a tiny sequential task runner.
//
// Long operations (deploy, update, install, asset download) are expressed as a list
// of steps. Each step is either a child process (`cmd`/`args`) or a custom async
// function (`run`). Output is streamed to the terminal page; the runner only allows
// one task at a time so the repo is never touched by two operations at once.

import { runStream } from './util.mjs';

export class TaskRunner {
  /**
   * @param {{log:(entry:{channel:string,stream:string,line:string})=>void,
   *          onEvent?:(evt:object)=>void}} deps
   */
  constructor({ log, onEvent }) {
    this.log = log;
    this.onEvent = onEvent || (() => {});
    this.state = { status: 'idle', id: null, kind: null, label: '', step: '', stepIndex: 0, stepTotal: 0, startedAt: null, endedAt: null, exitCode: null, error: null };
    this.current = null;      // active runStream handle
    this.cancelled = false;
    this.seq = 0;
  }

  get busy() { return this.state.status === 'running'; }

  #patch(patch) {
    this.state = { ...this.state, ...patch };
    this.onEvent({ type: 'task', task: this.state });
  }

  /** Request cancellation of the running task's child process. */
  cancel() {
    if (!this.busy) return false;
    this.cancelled = true;
    this.log({ channel: this.state.kind || 'launcher', stream: 'meta', line: '⏹ 正在取消…' });
    this.current?.kill();
    return true;
  }

  /**
   * Run a task. Rejects when another task is already running.
   * @param {string} kind short id used as the log channel, e.g. 'deploy'
   * @param {string} label human label shown in the UI
   * @param {Array<{label:string,cmd?:string,args?:string[],cwd?:string,env?:object,optional?:boolean,run?:(ctx:object)=>Promise<void>}>} steps
   * @returns {Promise<{ok:boolean,code:number,cancelled:boolean}>}
   */
  async run(kind, label, steps) {
    if (this.busy) return { ok: false, code: -1, busy: true };
    this.cancelled = false;
    const id = `${kind}-${++this.seq}`;
    this.#patch({ status: 'running', id, kind, label, step: '', stepIndex: 0, stepTotal: steps.length, startedAt: Date.now(), endedAt: null, exitCode: null, error: null });
    this.log({ channel: kind, stream: 'meta', line: `▶ ${label}` });

    let code = 0;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (this.cancelled) { code = 130; break; }
      this.#patch({ step: step.label, stepIndex: i + 1 });
      this.log({ channel: kind, stream: 'meta', line: `── [${i + 1}/${steps.length}] ${step.label}` });
      try {
        if (typeof step.run === 'function') {
          await step.run({
            log: (line, stream = 'stdout') => this.log({ channel: kind, stream, line }),
            isCancelled: () => this.cancelled,
          });
        } else {
          const handle = runStream(step.cmd, step.args || [], {
            cwd: step.cwd,
            env: step.env,
            onLine: (stream, line) => this.log({ channel: kind, stream, line }),
          });
          this.current = handle;
          const res = await handle.done;
          this.current = null;
          if (res.error) throw res.error;
          if (res.code !== 0) {
            if (step.optional) {
              this.log({ channel: kind, stream: 'meta', line: `（可选步骤失败，已跳过：${step.label}）` });
              continue;
            }
            code = res.code;
            this.#patch({ error: `步骤失败：${step.label}（退出码 ${res.code}）` });
            break;
          }
        }
      } catch (e) {
        this.current = null;
        if (this.cancelled) { code = 130; break; }
        code = -1;
        this.log({ channel: kind, stream: 'stderr', line: `步骤出错：${step.label} — ${e?.message || e}` });
        this.#patch({ error: `步骤出错：${step.label} — ${e?.message || e}` });
        break;
      }
    }

    const ok = code === 0 && !this.cancelled;
    this.#patch({
      status: ok ? 'done' : (this.cancelled ? 'cancelled' : 'error'),
      step: '', stepIndex: steps.length, endedAt: Date.now(), exitCode: code,
    });
    this.log({ channel: kind, stream: 'meta', line: ok ? `✔ ${label} 完成` : (this.cancelled ? `⏹ ${label} 已取消` : `✘ ${label} 失败（退出码 ${code}）`) });
    return { ok, code, cancelled: this.cancelled };
  }
}
