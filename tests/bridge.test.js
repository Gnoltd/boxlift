// node tests/bridge.test.js -> bridge.js (page) <-> bridgeclient.js (content script) with a fake CVAT:
// frames come from CVAT's own cache; null (=> REST fallback) when the bridge is missing or another job
// is open; errors and timeouts reach the caller.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { create } = require('../extension/function/bridgeclient.js');

let fail = 0;
const check = (name, ok) => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };

function fakeWindow() {
  const win = new EventTarget();
  win.location = { origin: 'https://cvat.test' };
  win.postMessage = (data, origin, transfer = []) => {
    const ev = new Event('message');
    ev.data = structuredClone(data, { transfer }); ev.source = win;
    setTimeout(() => win.dispatchEvent(ev), 0);
  };
  return win;
}
function fakeCvat(win, job) {
  const store = { getState: () => ({ annotation: { job: { instance: job } } }) };
  win.cvatUI = { registerComponent: (b) => b({ store }) };
}
function loadBridge(win) {
  const document = new EventTarget();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/bridge.js'), 'utf8'),
    { window: win, document, location: win.location, Blob, console });
  return document;
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const pcd = new TextEncoder().encode('VERSION .7\nFIELDS x y z\n');
const job = {
  id: 7,
  frames: {
    get: async (n) => {
      if (n === 99) throw new Error('chunk failed');
      if (n === 50) await tick(200);
      return { filename: `scan_${n}.pcd`, data: async () => ({ imageData: new Blob([pcd]) }) };
    },
    contextImage: async (n) => ({ image_0: { w: 1920, n }, image_3: { w: 1920, n } }),
  },
};

(async () => {
  // 1. no bridge in the page: answer null at once (REST fallback), no waiting
  const lone = create(fakeWindow());
  await tick();
  check('no bridge -> null', (await lone.ask('cloud', { jobId: 7, frame: 1 }, 1000)) === null);

  // 2. bridge loaded before CVAT's plugins.ready, client created later (ping handshake)
  const win = fakeWindow();
  const doc = loadBridge(win);
  fakeCvat(win, job);
  doc.dispatchEvent(new Event('plugins.ready'));
  await tick();
  const c = create(win);
  await tick();
  check('ready after ping', c.ready);
  const cloud = await c.ask('cloud', { jobId: 7, frame: 3 }, 1000);
  check('cloud from CVAT cache: bytes + name', cloud && cloud.name === 'scan_3.pcd'
    && new TextDecoder().decode(cloud.buf).startsWith('VERSION'));
  const imgs = await c.ask('images', { jobId: 7, frame: 3 }, 1000);
  check('context images by name', Array.isArray(imgs) && imgs.map(([k]) => k).join() === 'image_0,image_3' && imgs[0][1].n === 3);

  // 3. another job open in the page -> null (caller uses the REST API for that job)
  check('other job -> null', (await c.ask('cloud', { jobId: 8, frame: 3 }, 1000)) === null);

  // 4. cvat-core error -> rejected with its message, no timeout flag
  try { await c.ask('cloud', { jobId: 7, frame: 99 }, 1000); check('error rejected', false); } catch (e) {
    check('error rejected with message', e.message === 'chunk failed' && !e.timeout);
  }

  // 5. CVAT still loading -> timeout flag (caller backs off instead of downloading again)
  try { await c.ask('cloud', { jobId: 7, frame: 50 }, 50); check('timeout rejected', false); } catch (e) {
    check('timeout rejected with timeout flag', e.timeout === true);
  }

  // 6. client created before CVAT registers the plugin: ready comes with the registration
  const win2 = fakeWindow();
  const c2 = create(win2);
  const doc2 = loadBridge(win2);
  await tick();
  check('not ready before CVAT', !c2.ready);
  fakeCvat(win2, job);
  doc2.dispatchEvent(new Event('plugins.ready'));
  await tick();
  check('ready when CVAT registers', c2.ready);

  if (fail) { console.error(`FAIL (${fail})`); process.exit(1); }
  console.log('PASS');
})();
