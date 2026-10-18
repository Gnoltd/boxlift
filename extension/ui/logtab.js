/*
 * logtab.js — logic cho tab Log thao tác
 *
 * Phụ thuộc: supalog.js (phải được nạp trước trong logtab.html)
 * Dùng EditLog.summary() nếu cần tái tính tóm tắt ở client.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = (k, v) => I18n.t(k, v);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const loc = () => (I18n.getLang() === 'en' ? 'en-GB' : 'vi-VN');

  // ── State ─────────────────────────────────────────────────────────────────
  let allSessions   = [];   // [{session_id, started_at, count}]
  let currentLogs   = [];   // record[] của phiên đang xem
  let filteredLogs  = [];   // sau khi áp filter
  let currentSession = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function fmtTs(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const date = d.toLocaleDateString(loc(), { day: '2-digit', month: '2-digit' });
    const time = d.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `${date} ${time}`;
  }

  function fmtSessionLabel(s) {
    const dt = new Date(s.started_at);
    const date = dt.toLocaleDateString(loc(), { weekday: 'short', day: '2-digit', month: '2-digit' });
    const time = dt.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit', hour12: false });
    return t('log.session.label', { date, time, n: s.count });
  }

  function pct(v, total) {
    return total ? `${((v / total) * 100).toFixed(1)}%` : '—';
  }

  function toCsv(rows) {
    const COLS = ['id','created_at','session_id','job','frame','camera','action','how','model',
      'label','score','points','edited','iou','dyaw_deg','label_changed','extension_version'];
    const cell = EditLog.csvCell;
    const lines = [COLS.join(',')];
    for (const r of rows) lines.push(COLS.map((c) => cell(r[c])).join(','));
    return lines.join('\n') + '\n';
  }

  function showMsg(text, isError = false) {
    const el = $('msg');
    el.textContent = text;
    el.className   = 'msg ' + (isError ? 'error' : 'ok');
    el.hidden      = false;
    setTimeout(() => { el.hidden = true; }, 4000);
  }

  function setLoading(yes) {
    $('loading').hidden = !yes;
    $('tableWrap').hidden = yes;
  }

  // ── Check config ─────────────────────────────────────────────────────────

  async function checkConfig() {
    const ok = await SupaLog.isConfigured();
    $('noConfig').hidden = true;
    $('mainContent').hidden = false;
    const warn = $('expiryWarn');
    if (ok) {
      // log chưa lên được Supabase (lỗi đăng nhập, mạng) hay đã bị bỏ vì storage đầy: nói rõ thay vì để người dùng tưởng đã đồng bộ
      const st = await SupaLog.syncStatus();
      const lines = [];
      if (st.queued || st.sessionsPending) lines.push(t('log.warn.pending', { n: st.queued, s: st.sessionsPending, msg: st.error || '—' }));
      if (st.dropped) lines.push(t('log.warn.dropped', { n: st.dropped }));
      warn.textContent = lines.join(' ');
      warn.hidden = !lines.length;
      return true;
    }
    const local = await SupaLog.getLocalLogs();
    if (local.length > 0) {
      warn.textContent = t('log.warn.local1', { n: local.length });
    } else {
      warn.textContent = t('log.warn.local0');
    }
    warn.hidden = false;
    return true;
  }

  // ── Sessions dropdown ─────────────────────────────────────────────────────

  async function loadSessions() {
    if (await SupaLog.isConfigured()) {
      allSessions = await SupaLog.getSessions();
    } else {
      const local = await SupaLog.getLocalLogs();
      const sMap = new Map();
      for (const r of local) {
        const sid = r.session_id || 'local-session';
        const cur = sMap.get(sid) || { session_id: sid, started_at: r.created_at, count: 0 };
        cur.count++;
        sMap.set(sid, cur);
      }
      allSessions = Array.from(sMap.values());
    }
    const sel = $('sessionSelect');
    sel.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: `— ${t('log.sessions.all')} —` }));
    for (const s of allSessions) {
      const opt = document.createElement('option');
      opt.value       = s.session_id;
      opt.textContent = fmtSessionLabel(s);
      sel.appendChild(opt);
    }
    // Mặc định chọn phiên mới nhất
    if (allSessions.length) {
      sel.value      = allSessions[0].session_id;
      currentSession = allSessions[0].session_id;
    }
  }

  // ── Load + render logs ────────────────────────────────────────────────────

  async function loadLogs() {
    setLoading(true);
    try {
      if (await SupaLog.isConfigured()) {
        currentLogs = await SupaLog.getLogs(currentSession || null);
      } else {
        const local = await SupaLog.getLocalLogs();
        currentLogs = currentSession ? local.filter((r) => r.session_id === currentSession) : local;
      }
    } catch (e) {
      showMsg(t('log.err.load', { msg: e.message }), true);
      currentLogs = [];
    }
    applyFilter();
    setLoading(false);
  }

  function applyFilter() {
    const jobF    = $('filterJob').value.trim().toLowerCase();
    const actionF = $('filterAction').value;
    const fromF   = $('filterFrom').value;
    const toF     = $('filterTo').value;

    filteredLogs = currentLogs.filter((r) => {
      if (jobF    && !String(r.job ?? '').toLowerCase().includes(jobF)) return false;
      if (actionF && r.action !== actionF)                              return false;
      if (fromF   && r.created_at < fromF)                             return false;
      if (toF     && r.created_at > toF + 'T23:59:59')                 return false;
      return true;
    });

    renderTable();
    renderSummary();
    checkExpiryWarning();
  }

  function renderTable() {
    const tbody = $('logBody');
    tbody.innerHTML = '';

    if (!filteredLogs.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-row">${t('log.empty')}</td></tr>`;
      return;
    }

    for (const r of filteredLogs) {
      const tr = document.createElement('tr');
      tr.dataset.id = r.id;

      const editedBadge = r.edited == null ? '<span class="badge muted">—</span>'
        : r.edited ? `<span class="badge warn">${t('log.edited')}</span>`
        : `<span class="badge ok">${t('log.kept')}</span>`;

      const actionBadge = r.action === 'save'
        ? '<span class="badge ok">save</span>'
        : '<span class="badge muted">skip</span>';

      const dlBadge = r.downloaded
        ? `<span class="badge ok" title="${t('log.dl.tip')}">✓</span>` : '';

      tr.innerHTML = `
        <td class="mono">${fmtTs(r.created_at)}</td>
        <td class="mono">${esc(r.job ?? '—')}</td>
        <td class="mono">${esc(r.frame ?? '—')}</td>
        <td>${esc(r.camera ?? '—')}</td>
        <td>${actionBadge}</td>
        <td>${esc(r.how ?? '—')}</td>
        <td>${editedBadge}</td>
        <td class="mono">${r.iou != null ? r.iou.toFixed(3) : '—'}</td>
        <td>${dlBadge}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  function renderSummary() {
    const saved   = filteredLogs.filter((r) => r.action === 'save');
    const edited  = saved.filter((r) => r.edited === true);
    const skipped = filteredLogs.filter((r) => r.action === 'skip');

    $('sumTotal').textContent  = filteredLogs.length;
    $('sumSaved').textContent  = saved.length;
    $('sumEdited').textContent = `${edited.length} (${pct(edited.length, saved.length)})`;
    $('sumSkipped').textContent = skipped.length;

    // Tính thời lượng phiên
    let durSec = 0;
    if (filteredLogs.length > 1) {
      const times = filteredLogs.map((r) => new Date(r.created_at || 0).getTime()).filter((t) => t > 0);
      if (times.length > 1) {
        const minT = Math.min(...times);
        const maxT = Math.max(...times);
        durSec = Math.max(1, Math.round((maxT - minT) / 1000));
      }
    }
    const m = Math.floor(durSec / 60);
    const s = durSec % 60;
    const durStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
    if ($('sumDuration')) $('sumDuration').textContent = durStr;

    // Tốc độ và tăng tốc
    if ($('sumSpeed')) {
      const spd = saved.length > 0 ? (durSec / saved.length).toFixed(1) + 's' : '—';
      $('sumSpeed').textContent = spd;
    }
  }

  function checkExpiryWarning() {
    // Kiểm tra có log nào còn < 5 ngày trước khi bị xoá không
    const cutoff = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const deadline = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString();
    const soonExpire = currentLogs.filter(
      (r) => !r.downloaded && r.created_at < cutoff && r.created_at > deadline
    );
    const warn = $('expiryWarn');
    if (soonExpire.length) {
      warn.textContent = t('log.expiry', { n: soonExpire.length });
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }

  // ── Download CSV ──────────────────────────────────────────────────────────

  async function downloadCsv() {
    if (!filteredLogs.length) { showMsg(t('log.nodl'), true); return; }

    const csv  = toCsv(filteredLogs);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);

    const session = currentSession || 'all';
    const ts      = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const a       = document.createElement('a');
    a.href        = url;
    a.download    = `calib-overlay-log_${session.slice(0, 8)}_${ts}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    // Đánh dấu đã tải
    const ids = filteredLogs.map((r) => r.id);
    try {
      await SupaLog.markDownloaded(ids);
      // Cập nhật local state
      for (const r of currentLogs) {
        if (ids.includes(r.id)) r.downloaded = true;
      }
      applyFilter();
      showMsg(t('log.dl.done', { n: ids.length }));
    } catch (e) {
      showMsg(t('log.dl.nomark', { msg: e.message }), true);
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async function deleteSession() {
    if (!currentSession) { showMsg(t('log.del.pick'), true); return; }
    if (!confirm(t('log.del.session.confirm', { n: currentLogs.length }))) return;
    try {
      await SupaLog.deleteSession(currentSession);
      showMsg(t('log.del.session.done'));
      await refresh();
    } catch (e) {
      showMsg(t('log.err.del', { msg: e.message }), true);
    }
  }

  async function deleteAll() {
    const total = allSessions.reduce((s, x) => s + x.count, 0);
    if (!confirm(t('log.del.all.confirm', { n: total }))) return;
    try {
      await SupaLog.deleteAll();
      showMsg(t('log.del.all.done'));
      await refresh();
    } catch (e) {
      showMsg(t('log.err.del', { msg: e.message }), true);
    }
  }

  // ── Refresh ───────────────────────────────────────────────────────────────

  async function refresh() {
    const ok = await checkConfig();
    if (!ok) return;
    await loadSessions();
    await loadLogs();
  }

  // ── Events ────────────────────────────────────────────────────────────────

  $('sessionSelect').addEventListener('change', async (e) => {
    currentSession = e.target.value || null;
    await loadLogs();
  });

  $('filterJob').addEventListener('input', applyFilter);
  $('filterAction').addEventListener('change', applyFilter);
  $('filterFrom').addEventListener('change', applyFilter);
  $('filterTo').addEventListener('change', applyFilter);

  $('btnDownload').addEventListener('click', downloadCsv);
  $('btnDeleteSession').addEventListener('click', deleteSession);
  $('btnDeleteAll').addEventListener('click', deleteAll);
  $('btnRefresh').addEventListener('click', refresh);

  $('configLink').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  PageI18n.init(() => { if (!$('mainContent').hidden) refresh(); }).then(refresh);
})();
