/* Minimal ZIP reader (stored + deflate) for CVAT's context-image and data chunks. Uses DecompressionStream. */
(function (root) {
  'use strict';

  // One entry never legitimately needs more than this (a dense point cloud is tens of MB); a larger one is a bomb or a
  // broken server, and reading it whole would exhaust the tab's memory.
  const MAX_ENTRY = 256 * 1024 * 1024;

  /**
   * Inflate one entry. `size` is the uncompressed size the archive declares: the result is written straight into one buffer of that
   * size (no second copy, so the peak is the entry itself), and an entry that inflates past its declared size, or past `limit`,
   * is refused. Without a usable `size` (unknown / zip64) the chunks are gathered and copied once, still under `limit`.
   */
  async function inflateRaw(bytes, size, limit = MAX_ENTRY) {
    const known = Number.isInteger(size) && size >= 0 && size !== 0xFFFFFFFF;
    if (known && size > limit) throw new Error('ZIP: dữ liệu giải nén quá lớn (' + (limit >> 20) + ' MB)');
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const cap = known ? size : limit;
    const fixed = known ? new Uint8Array(size) : null;
    let parts = known ? null : [], total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > cap) { reader.cancel().catch(() => {}); throw new Error('ZIP: dữ liệu giải nén quá lớn (' + (cap >> 20 || 1) + ' MB)'); }
      if (fixed) fixed.set(value, total); else parts.push(value);
      total += value.length;
    }
    if (fixed) return total === size ? fixed : fixed.subarray(0, total);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    parts = null;
    return out;
  }

  /** Entries without decompressing: [{name, get(): Promise<Uint8Array>}] in archive order. */
  function listZip(buffer) {
    const dv = new DataView(buffer), u8 = new Uint8Array(buffer);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('không phải file ZIP');
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder(), out = [];
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP hỏng (central directory)');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      const get = async () => {
        const ln = dv.getUint16(lho + 26, true), lx = dv.getUint16(lho + 28, true);
        const data = u8.subarray(lho + 30 + ln + lx, lho + 30 + ln + lx + csize);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data, usize);
        throw new Error('ZIP method không hỗ trợ: ' + method);
      };
      out.push({ name, get });
    }
    return out;
  }

  /** -> Map(name -> Uint8Array) */
  async function readZip(buffer) {
    const files = new Map();
    for (const e of listZip(buffer)) files.set(e.name, await e.get());
    return files;
  }

  const api = { readZip, listZip, inflateRaw };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniZip = api;
})(typeof self !== 'undefined' ? self : this);
