// Toolbar icon -> options (add your CVAT domain). Custom domains are registered as dynamic
// content scripts after the user grants that one origin.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// same scripts as the built-in CVAT origins in manifest.json: [0] the MAIN-world bridge, [1] the content scripts
const [BRIDGE, MAIN] = chrome.runtime.getManifest().content_scripts;
const IDS = ['cvat-custom', 'cvat-custom-bridge'];
async function sync() {
  const { origins = [] } = await chrome.storage.local.get('origins');
  const granted = [];
  for (const o of origins) if (await chrome.permissions.contains({ origins: [o + '/*'] })) granted.push(o + '/*');
  const old = await chrome.scripting.getRegisteredContentScripts({ ids: IDS });
  if (old.length) await chrome.scripting.unregisterContentScripts({ ids: old.map((o) => o.id) });
  if (granted.length) {
    await chrome.scripting.registerContentScripts([
      { id: 'cvat-custom', matches: granted, js: MAIN.js, runAt: MAIN.run_at },
      // in the page itself: hands over the frames CVAT already downloaded (no second download)
      { id: 'cvat-custom-bridge', matches: granted, js: BRIDGE.js, runAt: BRIDGE.run_at, world: BRIDGE.world },
    ]);
  }
}
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.storage.onChanged.addListener((c) => { if (c.origins) sync(); });
chrome.permissions.onAdded.addListener(sync);
chrome.permissions.onRemoved.addListener(sync);

// Content scripts get the bundled calibrations through these messages instead of web-accessible URLs,
// so no page (CVAT or other) can read extension files directly.
//   {type: 'listCalibs'}        -> calibs/index.json (profiles with a task-name pattern)
//   {type: 'getCalib', id}      -> calibs/<id>.json
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  let file = null;
  if (msg.type === 'listCalibs') file = 'calibs/index.json';
  else if (msg.type === 'getDbConfig') file = 'config/database.json';   // content scripts cannot fetch it (not web-accessible, so the key is not exposed to pages)
  else if (msg.type === 'getCalib' && /^[\w.-]+$/.test(String(msg.id || ''))) file = `calibs/${msg.id}.json`;
  if (!file) return;
  fetch(chrome.runtime.getURL(file))
    .then((r) => { if (!r.ok) throw new Error(`${file}: ${r.status}`); return r.json(); })
    .then((data) => reply({ ok: true, data }))
    .catch((e) => reply({ ok: false, error: String(e && e.message || e) }));
  return true;   // async reply
});
