/* Minimal PCD v0.7 reader: ascii, binary and binary_compressed (LZF). Returns xyz Float32Array. */
(function (root) {
  'use strict';

  function lzfDecompress(src, outLen) {
    const out = new Uint8Array(outLen);
    let ip = 0, op = 0;
    while (ip < src.length) {
      let ctrl = src[ip++];
      if (ctrl < 32) {                       // literal run
        ctrl++;
        out.set(src.subarray(ip, ip + ctrl), op); ip += ctrl; op += ctrl;
      } else {                               // back reference
        let len = ctrl >> 5;
        let ref = op - ((ctrl & 0x1f) << 8) - 1;
        if (len === 7) len += src[ip++];
        ref -= src[ip++];
        len += 2;
        for (let k = 0; k < len; k++) out[op++] = out[ref++];
      }
    }
    return out;
  }

  function parsePCD(buffer) {
    const bytes = new Uint8Array(buffer);
    let pos = 0, header = {};
    const dec = new TextDecoder();
    while (pos < bytes.length) {
      let end = bytes.indexOf(10, pos);
      if (end < 0) end = bytes.length;
      const line = dec.decode(bytes.subarray(pos, end)).trim();
      pos = end + 1;
      if (!line || line.startsWith('#')) continue;
      const [key, ...vals] = line.split(/\s+/);
      header[key] = vals;
      if (key === 'DATA') break;
    }
    const fields = header.FIELDS, size = header.SIZE.map(Number), type = header.TYPE;
    const count = (header.COUNT || fields.map(() => '1')).map(Number);
    const n = Number(header.POINTS ? header.POINTS[0] : Number(header.WIDTH[0]) * Number(header.HEIGHT[0]));
    const fmt = header.DATA[0];
    const fi = ['x', 'y', 'z'].map((f) => fields.indexOf(f));
    if (fi.some((i) => i < 0)) throw new Error('PCD thiếu trường x/y/z');
    const xyz = new Float32Array(n * 3);
    if (fmt === 'ascii') {
      const lines = dec.decode(bytes.subarray(pos)).split('\n');
      const col = fi.map((i) => count.slice(0, i).reduce((a, b) => a + b, 0));
      let m = 0;
      for (const ln of lines) {
        if (m >= n) break;
        const t = ln.trim().split(/\s+/);
        if (t.length < fields.length) continue;
        for (let k = 0; k < 3; k++) xyz[3 * m + k] = parseFloat(t[col[k]]);
        m++;
      }
      return xyz;
    }
    for (const i of fi) if (type[i] !== 'F' || size[i] !== 4) throw new Error('chỉ hỗ trợ x/y/z float32');
    if (fmt === 'binary') {
      const stride = size.reduce((a, s, i) => a + s * count[i], 0);
      const off = fi.map((i) => size.slice(0, i).reduce((a, s, j) => a + s * count[j], 0));
      const dv = new DataView(buffer, pos);
      for (let p = 0; p < n; p++) for (let k = 0; k < 3; k++) xyz[3 * p + k] = dv.getFloat32(p * stride + off[k], true);
      return xyz;
    }
    if (fmt === 'binary_compressed') {
      const dv = new DataView(buffer, pos);
      const csize = dv.getUint32(0, true), usize = dv.getUint32(4, true);
      const raw = lzfDecompress(new Uint8Array(buffer, pos + 8, csize), usize);
      const rdv = new DataView(raw.buffer);
      // column-major: each field stored contiguously
      const colOff = []; let o = 0;
      for (let i = 0; i < fields.length; i++) { colOff.push(o); o += size[i] * count[i] * n; }
      for (let p = 0; p < n; p++) for (let k = 0; k < 3; k++) xyz[3 * p + k] = rdv.getFloat32(colOff[fi[k]] + p * 4, true);
      return xyz;
    }
    throw new Error('DATA không hỗ trợ: ' + fmt);
  }

  const api = { parsePCD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PCD = api;
})(typeof self !== 'undefined' ? self : this);
