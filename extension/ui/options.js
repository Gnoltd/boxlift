const $ = (id) => document.getElementById(id);
const t = (k, v) => I18n.t(k, v);
const OPTS_KEY = 'viewOpts';                       // the same record the BoxLift window keeps: the language is shared
const SUPABASE_CONFIG_KEY = 'supalog:config';
const DEVICE_KEY = 'supalog:deviceId';
const say = (id, text, cls = '') => { $(id).textContent = text; $(id).className = `small ${cls}`.trim(); };

// ── CVAT hosts ───────────────────────────────────────────────────────────────
async function render() {
  const { origins = [] } = await chrome.storage.local.get('origins');
  $('list').replaceChildren();
  for (const o of origins) {
    const ok = await chrome.permissions.contains({ origins: [o + '/*'] });
    const li = document.createElement('li');
    const code = Object.assign(document.createElement('code'), { textContent: o });
    const state = Object.assign(document.createElement('span'), { textContent: t(ok ? 'opt.cvat.granted' : 'opt.cvat.denied'), className: `small ${ok ? 'ok' : 'err'}` });
    const del = Object.assign(document.createElement('button'), { textContent: t('opt.cvat.remove'), className: 'ghost' });
    del.onclick = async () => {
      await chrome.storage.local.set({ origins: origins.filter((x) => x !== o) });
      await chrome.permissions.remove({ origins: [o + '/*'] }).catch(() => {});
      render();
    };
    li.append(code, state, del); $('list').appendChild(li);
  }
}
$('add').onclick = async () => {
  let o;
  try { o = new URL($('url').value.trim()).origin; } catch { say('msg', t('opt.cvat.badurl'), 'err'); return; }
  const granted = await chrome.permissions.request({ origins: [o + '/*'] });   // must run in the click handler
  if (!granted) { say('msg', t('opt.cvat.denied.msg', { origin: o }), 'err'); return; }
  const { origins = [] } = await chrome.storage.local.get('origins');
  if (!origins.includes(o)) origins.push(o);
  await chrome.storage.local.set({ origins });
  say('msg', t('opt.cvat.added', { origin: o }), 'ok'); $('url').value = ''; render();
};
$('clear').onclick = async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('calib:') || k.startsWith('calibTask:')));
  say('calMsg', t('opt.calib.cleared'), 'ok');
};

// ── Supabase config ──────────────────────────────────────────────────────────
// The project's default URL / key (config/database.json) is never shown here: the page only says whether it is in use.
async function renderSupabase() {
  const { [SUPABASE_CONFIG_KEY]: customCfg, [DEVICE_KEY]: storedDevId, 'supalog:auth': auth } = await chrome.storage.local.get([SUPABASE_CONFIG_KEY, DEVICE_KEY, 'supalog:auth']);
  let deviceId = (auth && auth.user_id) || storedDevId;      // the id Supabase knows this device by once it has signed in
  if (!deviceId && typeof SupaLog !== 'undefined' && SupaLog.getDeviceId) { try { deviceId = await SupaLog.getDeviceId(); } catch {} }
  let activeCfg = null;
  if (typeof SupaLog !== 'undefined' && SupaLog.getConfig) activeCfg = await SupaLog.getConfig();

  $('supUrl').placeholder = 'https://xxxx.supabase.co';
  if (customCfg && customCfg.url) { $('supUrl').value = customCfg.url; say('supMsg', t('opt.log.custom'), 'ok'); }
  else if (activeCfg && activeCfg.url) { $('supUrl').value = ''; say('supMsg', t('opt.log.default'), 'ok'); }
  else { $('supUrl').value = ''; say('supMsg', t('opt.log.none')); }

  const line = $('deviceIdLine'); line.replaceChildren();
  if (deviceId) {
    const b = Object.assign(document.createElement('b'), { textContent: t('opt.log.device') + ': ' });
    line.append(b, Object.assign(document.createElement('code'), { textContent: deviceId }), document.createElement('br'), t('opt.log.rls'));
  } else line.textContent = t('opt.log.devicepending');
}
$('supSave').onclick = async () => {
  const rawUrl = $('supUrl').value.trim(), key = $('supKey').value.trim();
  if (!rawUrl) { say('supMsg', t('opt.log.needurl'), 'err'); return; }
  if (!key) { say('supMsg', t('opt.log.needkey'), 'err'); return; }
  let url;
  try { url = new URL(rawUrl).origin; } catch { say('supMsg', t('opt.log.badurl'), 'err'); return; }
  await chrome.storage.local.set({ [SUPABASE_CONFIG_KEY]: { url, anonKey: key } });
  $('supKey').value = '';                                  // the key does not stay on screen
  await renderSupabase(); say('supMsg', t('opt.log.saved', { url }), 'ok');
};
$('supClear').onclick = async () => {
  if (!confirm(t('opt.log.confirmclear'))) return;
  await chrome.storage.local.remove(SUPABASE_CONFIG_KEY);
  await renderSupabase(); say('supMsg', t('opt.log.cleared'), 'ok');
};

// ── language (VI | EN), shared with the BoxLift window ───────────────────────
function applyLang() {
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const b of [$('langVi'), $('langEn')]) b.setAttribute('aria-pressed', String(b.dataset.lang === I18n.getLang()));
  document.documentElement.lang = I18n.getLang();
  render(); renderSupabase();
}
for (const b of [$('langVi'), $('langEn')]) b.onclick = async () => {
  I18n.setLang(b.dataset.lang);
  const o = (await chrome.storage.local.get(OPTS_KEY))[OPTS_KEY] || {};
  await chrome.storage.local.set({ [OPTS_KEY]: { ...o, lang: I18n.getLang() } });
  applyLang();
};
chrome.storage.local.get(OPTS_KEY).then((r) => { I18n.setLang((r[OPTS_KEY] || {}).lang || 'vi'); applyLang(); });
