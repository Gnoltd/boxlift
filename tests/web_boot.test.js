// node tests/web_boot.test.js — Boot.supported (pure) + helper for restoring a tour after reload.
const assert = require('assert');
const Boot = require('../web/boot.js');

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EDGE = CHROME + ' Edg/126.0.0.0';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

assert.deepStrictEqual(Boot.supported(CHROME, 1280), { ok: true });
assert.deepStrictEqual(Boot.supported(EDGE, 1000), { ok: true });
assert.deepStrictEqual(Boot.supported(FIREFOX, 1280), { ok: false, reason: 'browser' });
assert.deepStrictEqual(Boot.supported(SAFARI, 1280), { ok: false, reason: 'browser' });
assert.deepStrictEqual(Boot.supported(CHROME, 800), { ok: false, reason: 'width' });
assert.deepStrictEqual(Boot.supported(CHROME, 999), { ok: false, reason: 'width' });
assert.deepStrictEqual(Boot.supported('', 1280), { ok: false, reason: 'browser' });
assert.deepStrictEqual(Boot.supported(FIREFOX, 500), { ok: false, reason: 'browser' });

// restoreDetail: only when saved annotations hold something
assert.strictEqual(Boot.restoreDetail(null), null);
assert.strictEqual(Boot.restoreDetail('not json'), null);
assert.strictEqual(Boot.restoreDetail(JSON.stringify({ shapes: [], tracks: [] })), null);
assert.deepStrictEqual(Boot.restoreDetail(JSON.stringify({ shapes: [{}], tracks: [{}, {}] })), { action: 'restore', shapes: 1, tracks: 2 });

console.log('web_boot ok');
