/* Chuỗi tĩnh + công tắc VI | EN cho các trang extension (tab Log, Calib Lab). Cần function/i18n.js nạp trước.
   Ngôn ngữ nhớ chung với cửa sổ BoxLift (viewOpts.lang). */
(function () {
  const OPTS_KEY = 'viewOpts';
  const t = (k, v) => I18n.t(k, v);
  function apply() {
    for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
    for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
    for (const e of document.querySelectorAll('[data-i18n-ph]')) e.placeholder = t(e.dataset.i18nPh);
    for (const b of document.querySelectorAll('.lang [data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === I18n.getLang()));
    document.documentElement.lang = I18n.getLang();
    if (document.body.dataset.title) document.title = `BoxLift · ${t(document.body.dataset.title)}`;
  }
  /** onChange: gọi sau khi đổi ngôn ngữ để trang vẽ lại phần động. Trả về Promise xong khi đã nạp ngôn ngữ đã lưu. */
  async function init(onChange = () => {}) {
    try { I18n.setLang(((await chrome.storage.local.get(OPTS_KEY))[OPTS_KEY] || {}).lang || 'vi'); } catch { /* mặc định VI */ }
    for (const b of document.querySelectorAll('.lang [data-lang]')) b.onclick = async () => {
      I18n.setLang(b.dataset.lang);
      try { const o = (await chrome.storage.local.get(OPTS_KEY))[OPTS_KEY] || {}; await chrome.storage.local.set({ [OPTS_KEY]: { ...o, lang: I18n.getLang() } }); } catch { /* chỉ là ghi nhớ */ }
      apply(); onChange();
    };
    apply();
  }
  self.PageI18n = { init, apply, t };
})();
