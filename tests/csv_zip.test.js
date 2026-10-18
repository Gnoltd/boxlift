// node tests/csv_zip.test.js — CSV cells never start a spreadsheet formula, and a ZIP entry that inflates past the cap is refused.
const zlib = require('zlib');
const EL = require('../extension/function/editlog.js');
const Z = require('../extension/function/zip.js');
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } else console.log('ok  ', msg); };

const c = EL.csvCell;
check(c('=HYPERLINK("http://x")') === `"'=HYPERLINK(""http://x"")"`, 'formula: quoted and defused');
check(c('+1+1') === "'+1+1", '+ formula defused');
check(c('@SUM(A1)') === "'@SUM(A1)", '@ formula defused');
check(c('-cmd|calc') === "'-cmd|calc", '- text defused');
check(c(' =1+1') === "' =1+1", 'space before formula defused');
check(c('\t=1+1') === "\"'\t=1+1\"" || c('\t=1+1').startsWith("'"), 'tab before formula defused');
check(c('\u200b=1+1').startsWith("'") && c('\u00a0@x').startsWith("'") && c('\ufeff+1+1').startsWith("'"), 'zero-width / nbsp before formula defused');
check(c('  \t -cmd') .startsWith("'"), 'mixed whitespace then - defused');
check(['1e3', '-1e-3', '+1.5E+2', '5.', '-5.', '+.5', '-12'].every((n) => c(n) === n), 'numbers in any notation unchanged');
check(c(' 5') === ' 5' && c('a=b') === 'a=b' && c('x -1') === 'x -1', 'text with = or - not at the start is untouched');
check(c(-1.5) === '-1.5' && c('-1.5') === '-1.5' && c(0.25) === '0.25', 'numbers unchanged, negative too');
check(c('car') === 'car' && c(null) === '' && c('a,b') === '"a,b"' && c('a\nb') === '"a\nb"', 'plain text, empty, comma and newline');

// a one-entry ZIP (deflate) with the sizes the central directory declares
function zipOf(name, raw, declared = raw.length) {
  const data = zlib.deflateRawSync(raw), nm = Buffer.from(name);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(declared, 24); cd.writeUInt16LE(nm.length, 28);
  const at = lh.length + nm.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length + nm.length, 12); end.writeUInt32LE(at, 16);
  const all = Buffer.concat([lh, nm, data, cd, nm, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

(async () => {
  const raw = Buffer.alloc(2 * 1024 * 1024, 7);
  const packed = new Uint8Array(zlib.deflateRawSync(raw));
  check((await Z.inflateRaw(packed, raw.length)).length === raw.length, 'declared size: all bytes, written into one buffer');
  check((await Z.inflateRaw(packed)).length === raw.length, 'unknown size: all bytes (chunks gathered once)');
  const refuse = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };
  check(/quá lớn/.test(await refuse(() => Z.inflateRaw(packed, raw.length, 1024 * 1024))), 'declared size over the cap is refused before inflating');
  check(/quá lớn/.test(await refuse(() => Z.inflateRaw(packed, 1024 * 1024))), 'an entry that inflates past its declared size is refused');
  check(/quá lớn/.test(await refuse(() => Z.inflateRaw(packed, undefined, 1024 * 1024))), 'unknown size over the cap is refused');
  check((await Z.inflateRaw(packed, raw.length + 100)).length === raw.length, 'declared larger than real: the real bytes only');

  const files = await Z.readZip(zipOf('a.bin', raw));
  check(files.get('a.bin').length === raw.length && files.get('a.bin')[0] === 7, 'readZip: entry read through the central directory size');
  check(/quá lớn/.test(await refuse(() => Z.readZip(zipOf('a.bin', raw, 1024)))), 'readZip: central directory understating the size is refused');
  process.exit(fail ? 1 : 0);
})();
