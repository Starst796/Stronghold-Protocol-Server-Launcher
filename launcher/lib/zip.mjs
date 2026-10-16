// launcher/lib/zip.mjs — a minimal, dependency-free ZIP reader.
//
// Release assets are zips, and the launcher has to unpack them on every platform: Windows ships no
// `unzip`, and GNU tar (Linux) cannot read zip the way bsdtar (macOS / Windows) can. So the reader
// lives in-process on top of zlib's raw inflate, and the archive is read by offset so a 900 MB
// release never has to fit in memory.
//
// A release asset comes from the project's own GitHub releases and is trusted, but the paths inside
// are still validated — an archive is data, and data can be wrong.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SENTINEL32 = 0xffffffff;
const SENTINEL16 = 0xffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Read exactly `length` bytes at `position`. */
function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done);
    if (n <= 0) throw new Error('zip 文件被截断。');
    done += n;
  }
  return buf;
}

/** The end-of-central-directory record, tolerant of a trailing comment. */
function findEocd(fd, size) {
  const window = 66 * 1024;
  const start = Math.max(0, size - window);
  const buf = readAt(fd, start, size - start);
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return start + i;
  }
  throw new Error('不是有效的 zip 文件（找不到中央目录）。');
}

/**
 * The central directory: one record per entry, holding the sizes and the local-header offset.
 * @param {string} zipPath
 * @returns {Array<{name:string,method:number,compSize:number,size:number,offset:number,isDir:boolean}>}
 */
export function listZipEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const eocd = findEocd(fd, size);
    const tail = readAt(fd, eocd, 22);
    let count = tail.readUInt16LE(10);
    let cdSize = tail.readUInt32LE(12);
    let cdOffset = tail.readUInt32LE(16);

    // Zip64: a >4 GB archive or >65535 entries stores these in a separate record. Only the counts and
    // the directory location matter here; per-entry sizes fall back to the extra field below.
    if (count === SENTINEL16 || cdSize === SENTINEL32 || cdOffset === SENTINEL32) {
      const locOffset = eocd - 20;
      if (locOffset < 0 || readAt(fd, locOffset, 4).readUInt32LE(0) !== SIG_EOCD64_LOC) {
        throw new Error('zip 是 Zip64 但没有 Zip64 定位记录，无法读取。');
      }
      const eocd64 = Number(readAt(fd, locOffset, 20).readBigUInt64LE(8));
      const rec = readAt(fd, eocd64, 56);
      if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new Error('zip 的 Zip64 记录损坏。');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }

    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i += 1) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) break;
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);

      if (compSize === SENTINEL32 || size === SENTINEL32 || offset === SENTINEL32) {
        const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
        let e = 0;
        while (e + 4 <= extra.length) {
          const id = extra.readUInt16LE(e);
          const len = extra.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (size === SENTINEL32) { size = Number(extra.readBigUInt64LE(q)); q += 8; }
            if (compSize === SENTINEL32) { compSize = Number(extra.readBigUInt64LE(q)); q += 8; }
            if (offset === SENTINEL32) { offset = Number(extra.readBigUInt64LE(q)); }
            break;
          }
          e += 4 + len;
        }
      }

      const name = nameBytes.toString('utf8');
      entries.push({ name, method, compSize, size, offset, isDir: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** `true` for a path we are willing to create (relative, no traversal, no drive, no backslash). */
export function isSafeZipPath(name) {
  const s = String(name || '');
  if (!s || s.length > 512 || s.includes('\\') || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false;
  return s.split('/').every((seg) => seg !== '..');
}

/**
 * Unpack a zip into `destDir`. `filter(relPath)` may reject entries; progress is reported through
 * `onEntry(done, total, name)`.
 * @param {string} zipPath
 * @param {string} destDir
 * @param {{filter?:(rel:string)=>boolean, onEntry?:(done:number,total:number,name:string)=>void}} [o]
 * @returns {{files:number, bytes:number, skipped:number}}
 */
export function unzipToDir(zipPath, destDir, { filter, onEntry } = {}) {
  const entries = listZipEntries(zipPath).filter((e) => !e.isDir && isSafeZipPath(e.name));
  const root = path.resolve(destDir);
  const fd = fs.openSync(zipPath, 'r');
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  try {
    let done = 0;
    for (const entry of entries) {
      done += 1;
      if (filter && !filter(entry.name)) { skipped += 1; continue; }
      const target = path.resolve(root, entry.name);
      if (target !== root && !target.startsWith(root + path.sep)) { skipped += 1; continue; }
      const local = readAt(fd, entry.offset, 30);
      if (local.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`zip 条目损坏：${entry.name}`);
      const dataAt = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = entry.compSize > 0 ? readAt(fd, dataAt, entry.compSize) : Buffer.alloc(0);
      let body;
      if (entry.method === METHOD_STORE) body = raw;
      else if (entry.method === METHOD_DEFLATE) body = zlib.inflateRawSync(raw);
      else throw new Error(`zip 用了不支持的压缩方式 ${entry.method}：${entry.name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      files += 1;
      bytes += body.length;
      onEntry?.(done, entries.length, entry.name);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { files, bytes, skipped };
}

/**
 * The single top-level directory of a zip, or `''` when entries sit at the root or there are several.
 * Release packages differ here: upstream wraps everything in `Stronghold-Protocol/`, a source archive
 * does not.
 * @param {string} zipPath
 */
export function zipWrapperDir(zipPath) {
  const tops = new Set();
  for (const e of listZipEntries(zipPath)) {
    if (e.isDir) continue;
    const top = e.name.split('/')[0];
    if (!top || top === e.name) return '';
    tops.add(top);
    if (tops.size > 1) return '';
  }
  return tops.size === 1 ? [...tops][0] : '';
}
