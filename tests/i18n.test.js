// node tests/i18n.test.js — bảng chuỗi VI / EN của BoxLift: hai ngôn ngữ cùng bộ khoá, thay {biến}, rơi về VI, số có dấu phẩy.
const I = require('../extension/function/i18n.js');
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } };
const vi = Object.keys(I.messages.vi), en = Object.keys(I.messages.en);
check(vi.length >= 70, `đủ chuỗi (${vi.length})`);
check(vi.every((k) => k in I.messages.en), 'EN thiếu: ' + vi.filter((k) => !(k in I.messages.en)).join(' '));
check(en.every((k) => k in I.messages.vi), 'VI thiếu: ' + en.filter((k) => !(k in I.messages.vi)).join(' '));
check(vi.every((k) => I.messages.vi[k] && I.messages.en[k]), 'có chuỗi rỗng');
// {biến} giống nhau ở hai ngôn ngữ
const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
check(vi.every((k) => vars(I.messages.vi[k]) === vars(I.messages.en[k])), 'biến {x} lệch giữa VI và EN');
I.setLang('vi');
check(I.t('save.ok') === 'Đã lưu', 'VI mặc định');
check(I.t('session.chip', { t: '12:05', n: 34 }) === '12:05 · 34 box', 'thay biến');
I.setLang('en');
check(I.t('save.ok') === 'Saved' && I.t('session.chip', { t: '01:00', n: 2 }) === '01:00 · 2 boxes', 'EN');
check(I.t('khong.co') === 'khong.co', 'khoá lạ trả về chính khoá');
check(I.setLang('xx') === 'en', 'ngôn ngữ lạ bị bỏ qua');
I.setLang('vi');
check(I.num(4.6) === '4,6' && I.parseNum('4,6') === 4.6 && I.parseNum('4.6') === 4.6, 'số VI');
I.setLang('en'); check(I.num(4.6) === '4.6', 'số EN');

// every key the window uses (I18N.t('x'), data-i18n*="x", the shortcut table, PTS) is in the table
const src = require('fs').readFileSync(require('path').join(__dirname, '../extension/cvat.js'), 'utf8');
const used = new Set([...src.matchAll(/I18N\.t\('([\w.]+)'/g)].map((m) => m[1]));
for (const m of src.matchAll(/data-i18n(?:-title|-aria)?="([\w.]+)"/g)) used.add(m[1]);
for (const m of src.matchAll(/'((?:k|keys|pts)\.[\w.]+)'/g)) used.add(m[1]);
const lost = [...used].filter((k) => !(k in I.messages.vi));
check(lost.length === 0, 'khoá dùng trong cvat.js nhưng thiếu trong bảng: ' + lost.join(' '));
console.log(fail ? `FAIL (${fail})` : 'all ok');
process.exit(fail ? 1 : 0);
