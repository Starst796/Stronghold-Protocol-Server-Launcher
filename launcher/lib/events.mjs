// launcher/lib/events.mjs — the in-process event bus and the bounded log ring buffer
// that backs the "终端" page. Everything the launcher does (deploy steps, the game
// server's stdout/stderr, version checks) is funnelled through here so the browser
// sees one interleaved, colour-preserving stream.

export class EventBus {
  #subs = new Set();

  /** @param {(evt:object)=>void} fn @returns {()=>void} unsubscribe */
  on(fn) {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  emit(evt) {
    for (const fn of [...this.#subs]) {
      try { fn(evt); } catch { /* a broken subscriber must not break the others */ }
    }
  }

  get size() { return this.#subs.size; }
}

/** Channels shown in the UI; each has a label and an accent colour key. */
export const CHANNELS = {
  launcher: '启动器',
  deploy: '部署',
  server: '服务器',
  update: '更新',
};

export class LogStore {
  /** @param {number} limit max retained lines */
  constructor(limit = 4000) {
    this.limit = limit;
    this.lines = [];
    this.seq = 0;
  }

  /**
   * @param {{channel?:string,stream?:'stdout'|'stderr'|'meta',line:string,ts?:number}} entry
   * @returns {object} the stored entry (with a monotonic `seq`)
   */
  push(entry) {
    const item = {
      seq: ++this.seq,
      ts: entry.ts ?? Date.now(),
      channel: entry.channel || 'launcher',
      stream: entry.stream || 'stdout',
      line: String(entry.line ?? ''),
    };
    this.lines.push(item);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    return item;
  }

  list() { return this.lines; }

  clear() { this.lines = []; }
}
