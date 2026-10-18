/*
 * session-popup.js — Giao diện Pop-Up Thống Kê & Analytics Dashboard trong Extension
 *
 * Tích hợp:
 *  - 2 Tab chính: Dashboard Phân Tích & Quản Lý Phiên
 *  - Trực quan hóa dữ liệu qua SvgCharts (SVG thuần, zero dependency)
 *  - Xem chi tiết từng phiên (Drill-down: Bảng đối chứng Manual vs Tool & Raw logs)
 *  - Xuất 1-click ra CSV và Markdown chuẩn P-009
 */
(function (root) {
  'use strict';

  const SM = typeof module !== 'undefined' && module.exports ? require('../function/session.js') : root.SessionManager;
  const EL = typeof module !== 'undefined' && module.exports ? require('../function/editlog.js') : root.EditLog;
  const SC = typeof module !== 'undefined' && module.exports ? require('./svg-charts.js') : root.SvgCharts;
  const I18 = typeof module !== 'undefined' && module.exports ? require('../function/i18n.js') : root.I18n;
  const t = (k, v) => I18.t(k, v);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const loc = () => (I18.getLang() === 'en' ? 'en-GB' : 'vi-VN');
  const CLOSE_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>';

  function fmtSec(sec) {
    if (!sec || isNaN(sec)) return '0s';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (m > 60) {
      const h = Math.floor(m / 60);
      return `${h}h ${m % 60}m`;
    }
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function fmtTs(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.toLocaleDateString(loc(), { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`;
  }

  class SessionPopupComponent {
    constructor(opts = {}) {
      this.origin = opts.origin || (typeof location !== 'undefined' ? location.origin : '');
      this.onCvatSave = opts.onCvatSave || null;
      this.onToast = opts.onToast || console.log;
      this.getActive = opts.getActive || null;                 // the live session of the BoxLift window (same object, not a stored copy)
      this.onSaveSession = opts.onSaveSession || null;         // "Lưu phiên": the window closes it and shows the summary
      this.onSessionChange = opts.onSessionChange || (() => {});
      this.currentTab = 'dashboard'; // 'dashboard' | 'sessions' | 'detail'
      this.selectedSessionId = null;
      this.sessions = [];
      this.activeSession = null;
      this.logs = [];
      this.isOpen = false;
      this.root = null;
    }

    mount(host) {
      this.root = host;
    }

    async open(tab = 'dashboard') {
      this.currentTab = tab;
      this.isOpen = true;
      await this.refreshData();
      this.render();
    }

    close() {
      this.isOpen = false;
      const el = this.root.querySelector('#sessionPopupBackdrop');
      if (el) el.remove();
    }

    async refreshData() {
      this.sessions = await SM.loadSessions(this.origin);
      this.activeSession = (this.getActive && this.getActive()) || await SM.loadActiveSession(this.origin);
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const key = `editlog:${this.origin}`;
        const res = await chrome.storage.local.get(key);
        this.logs = res[key] || [];
      }
    }

    render() {
      if (!this.root || !this.isOpen) return;
      let backdrop = this.root.querySelector('#sessionPopupBackdrop');
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'sessionPopupBackdrop';
        backdrop.className = 'sess-modal-backdrop';
        this.root.appendChild(backdrop);
      }

      backdrop.innerHTML = '';
      const modal = document.createElement('div');
      modal.className = 'sess-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-label', `BoxLift · ${t('log.title')}`);

      // Header
      const hd = document.createElement('div');
      hd.className = 'sess-hd';
      const logo = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL('assets/Logo/boxlift-mark.svg') : '';
      hd.innerHTML = `
        <span class="sess-brand"><img src="${esc(logo)}" alt="">BoxLift<span class="sub">${esc(t('log.title'))}</span></span>
        <span class="sess-sp"></span>
        <button class="sess-btn sm" id="sessBtnExportAll" title="${esc(t('sess.export.all.tip'))}">${esc(t('sess.export.all'))}</button>
        <button class="sess-ic" id="sessBtnClose" title="${esc(t('app.close'))} (Esc)" aria-label="${esc(t('app.close'))}">${CLOSE_SVG}</button>
      `;
      modal.appendChild(hd);

      // Tabs
      const tabs = document.createElement('div');
      tabs.className = 'sess-tabs';
      tabs.innerHTML = `
        <button class="sess-tab-btn ${this.currentTab === 'dashboard' ? 'active' : ''}" id="tabBtnDash">${esc(t('sess.tab.dash'))}</button>
        <button class="sess-tab-btn ${this.currentTab === 'sessions' ? 'active' : ''}" id="tabBtnList">${esc(t('sess.tab.list', { n: this.sessions.length + (this.activeSession ? 1 : 0) }))}</button>
        ${this.currentTab === 'detail' ? `<button class="sess-tab-btn active" id="tabBtnDetail">${esc(t('sess.tab.detail'))}</button>` : ''}
      `;
      modal.appendChild(tabs);

      // Body container
      const body = document.createElement('div');
      body.className = 'sess-body';
      modal.appendChild(body);
      backdrop.appendChild(modal);

      // Event listeners for tabs & header
      hd.querySelector('#sessBtnClose').onclick = () => this.close();
      hd.querySelector('#sessBtnExportAll').onclick = () => this.exportAllMarkdown();
      tabs.querySelector('#tabBtnDash').onclick = () => { this.currentTab = 'dashboard'; this.render(); };
      tabs.querySelector('#tabBtnList').onclick = () => { this.currentTab = 'sessions'; this.render(); };

      // Render tab view
      if (this.currentTab === 'dashboard') {
        this.renderDashboard(body);
      } else if (this.currentTab === 'sessions') {
        this.renderSessionsList(body);
      } else if (this.currentTab === 'detail') {
        this.renderSessionDetail(body);
      }
    }

    renderDashboard(body) {
      const allForAgg = [...this.sessions];
      if (this.activeSession) allForAgg.unshift(this.activeSession);
      const agg = SM.aggregateSessions(allForAgg);

      // 1. Executive KPI Grid
      const kpis = document.createElement('div');
      kpis.className = 'sess-kpi-grid';
      kpis.innerHTML = `
        <div class="sess-kpi-card highlight">
          <span class="sess-kpi-title">${esc(t('sess.kpi.speedup'))}</span>
          <span class="sess-kpi-val">${agg.overall_speedup == null ? '—' : agg.overall_speedup + '×'}</span>
          <span class="sess-kpi-sub">${esc(agg.overall_speedup == null ? t('sess.kpi.speedup.none') : t('sess.kpi.speedup.sub', { tool: agg.avg_tool_seconds }))}</span>
        </div>
        <div class="sess-kpi-card highlight">
          <span class="sess-kpi-title">${esc(t('sess.kpi.saved'))}</span>
          <span class="sess-kpi-val">${agg.overall_speedup == null ? '—' : fmtSec(agg.total_time_saved_seconds)}</span>
          <span class="sess-kpi-sub">${esc(t('sess.kpi.saved.sub'))}</span>
        </div>
        <div class="sess-kpi-card">
          <span class="sess-kpi-title">${esc(t('sess.kpi.adopt'))}</span>
          <span class="sess-kpi-val">${agg.overall_tool_adoption_pct}%</span>
          <span class="sess-kpi-sub">${esc(t('sess.kpi.adopt.sub', { a: agg.total_tool_boxes, b: agg.total_saved_boxes }))}</span>
        </div>
        <div class="sess-kpi-card">
          <span class="sess-kpi-title">${esc(t('sess.kpi.acc'))}</span>
          <span class="sess-kpi-val">${agg.overall_avg_iou || '—'}</span>
          <span class="sess-kpi-sub">${esc(t('sess.kpi.acc.sub', { yaw: agg.overall_avg_yaw_deg || '—' }))}</span>
        </div>
      `;
      body.appendChild(kpis);

      // 2. Chart: Speed trend over sessions
      const trendSection = document.createElement('div');
      trendSection.className = 'sess-section';
      trendSection.innerHTML = `
        <div class="sess-section-hd">
          <span>${esc(t('sess.trend.title'))}</span>
          <span class="sess-legend">
            <span><i class="sess-dot manual"></i>${esc(t('sess.legend.manual'))}</span>
            <span><i class="sess-dot tool"></i>${esc(t('sess.legend.tool'))}</span>
          </span>
        </div>
      `;
      const trendChartWrap = document.createElement('div');
      trendChartWrap.style.cssText = 'height:180px; width:100%;';
      const trendData = agg.speed_trend.map((d, i) => ({
        label: d.date || `#${i + 1}`,
        manual: d.manual_speed,
        tool: d.tool_speed
      }));
      trendChartWrap.appendChild(SC.lineChart(trendData, { width: 720, height: 180, emptyText: t('sess.trend.empty') }));
      trendSection.appendChild(trendChartWrap);
      body.appendChild(trendSection);

      // 3. Row: Methods breakdown + Accuracy histogram
      const row = document.createElement('div');
      row.className = 'sess-chart-row';

      // Method donut
      const mCard = document.createElement('div');
      mCard.className = 'sess-section';
      mCard.innerHTML = `<div class="sess-section-hd">${esc(t('sess.method.title'))}</div>`;
      const mWrap = document.createElement('div');
      mWrap.className = 'sess-method';
      const slices = [
        { label: t('sess.m.tracker'), count: agg.method_breakdown.tracker, color: 'var(--ok)' },
        { label: t('sess.m.auto'), count: agg.method_breakdown.auto, color: 'var(--accent)' },
        { label: t('sess.m.semi'), count: agg.method_breakdown.semi_auto, color: 'var(--accent-hi)' },
        { label: t('sess.m.manual'), count: agg.method_breakdown.manual, color: 'var(--warn)' },
        { label: t('sess.m.other'), count: agg.method_breakdown.learned + agg.method_breakdown.click_fit, color: 'var(--muted)' }
      ];
      mWrap.appendChild(SC.donutChart(slices, 120));

      const legend = document.createElement('div');
      legend.className = 'sess-method-legend';
      slices.forEach((s) => {
        const item = document.createElement('div');
        item.innerHTML = `<i class="sess-dot" style="background:${s.color}"></i><span>${esc(s.label)}: <b>${s.count}</b></span>`;
        legend.appendChild(item);
      });
      mWrap.appendChild(legend);
      mCard.appendChild(mWrap);
      row.appendChild(mCard);

      // Accuracy distribution
      const aCard = document.createElement('div');
      aCard.className = 'sess-section';
      aCard.innerHTML = `<div class="sess-section-hd">${esc(t('sess.iou.title'))}</div>`;
      const hist = agg.iou_histogram, histTotal = hist.high + hist.mid + hist.low, pctOf = (n) => (histTotal ? `${Math.round((100 * n) / histTotal)}%` : '—');
      const iouBars = [
        { label: t('sess.iou.high'), value: hist.high, max: histTotal || 1, color: 'var(--ok)', sub: pctOf(hist.high) },
        { label: t('sess.iou.mid'), value: hist.mid, max: histTotal || 1, color: 'var(--accent)', sub: pctOf(hist.mid) },
        { label: t('sess.iou.low'), value: hist.low, max: histTotal || 1, color: 'var(--err)', sub: pctOf(hist.low) }
      ];
      aCard.appendChild(SC.horizontalBars(iouBars));
      row.appendChild(aCard);
      body.appendChild(row);

      // 4. Class Breakdown Table
      const cSection = document.createElement('div');
      cSection.className = 'sess-section';
      cSection.innerHTML = `<div class="sess-section-hd">${esc(t('sess.class.title'))}</div>`;
      const table = document.createElement('table');
      table.className = 'sess-table';
      table.innerHTML = `
        <thead>
          <tr>
            <th>${esc(t('sess.th.class'))}</th>
            <th>${esc(t('sess.th.total'))}</th>
            <th>${esc(t('sess.th.tool'))}</th>
            <th>${esc(t('sess.th.avgtime'))}</th>
            <th>${esc(t('sess.th.iou'))}</th>
            <th>${esc(t('sess.th.unchanged'))}</th>
          </tr>
        </thead>
        <tbody>
          ${Object.values(agg.class_summary).length ? Object.values(agg.class_summary).map((c) => `
            <tr>
              <td><b>${esc(c.name)}</b></td>
              <td>${c.count}</td>
              <td>${c.tool_count} (${c.tool_adoption_pct}%)</td>
              <td class="sess-mono">${c.avg_seconds}s</td>
              <td class="sess-mono">${c.avg_iou || '—'}</td>
              <td><span class="sess-badge ok">${c.unchanged_pct}%</span></td>
            </tr>
          `).join('') : `<tr><td colspan="6" class="sess-empty-cell">${esc(t('sess.class.empty'))}</td></tr>`}
        </tbody>
      `;
      cSection.appendChild(table);
      body.appendChild(cSection);
    }

    renderSessionsList(body) {
      // 1. Thẻ phiên đang chạy (nếu có)
      if (this.activeSession) {
        const a = this.activeSession;
        const durNow = SM.snapshot(a).duration_seconds;          // working time: pauses and time away are not in it
        const card = document.createElement('div');
        card.className = 'sess-card active-sess';
        card.innerHTML = `
          <div class="sess-between">
            <span><span class="sess-badge ${a.status === 'paused' ? 'warn' : 'ok'}">${esc(t(a.status === 'paused' ? 'sess.status.paused' : 'sess.active'))}</span> &nbsp; <b>${esc(t('sess.current', { id: a.session_id.slice(0, 8) }))}</b></span>
            <span class="sess-mono sess-ok" style="font-weight:600" id="activeSessTimer">${fmtSec(durNow)}</span>
          </div>
          <div class="sess-sub">${esc(t('sess.jobline', { job: a.job_id || '—', at: fmtTs(a.started_at), frame: a.start_frame ?? '—' }))}</div>
          <div class="sess-stats">
            <div><small>${esc(t('sess.stat.total'))}</small><br><b>${a.saved_boxes}</b></div>
            <div><small>${esc(t('sess.stat.tool'))}</small><br><b>${a.tool_count}</b></div>
            <div><small>${esc(t('sess.stat.manual'))}</small><br><b>${a.manual_count}</b></div>
            <div><small>${esc(t('sess.stat.speed'))}</small><br><b>${a.avg_seconds_per_box_overall || 0}s/box</b></div>
          </div>
          <div class="sess-actions">
            <button class="sess-btn sm" id="btnActivePause">${esc(t(a.status === 'paused' ? 'sess.btn.resume' : 'sess.btn.pause'))}</button>
            <button class="sess-btn sm" id="btnActiveSaveSession">${esc(t('sess.btn.savenew'))}</button>
            <button class="sess-btn pri sm" id="btnActiveSave">${esc(t('sess.btn.cvat'))}</button>
            <button class="sess-btn sm" id="btnActiveDetail">${esc(t('sess.btn.detail'))}</button>
          </div>
        `;
        const btnPause = card.querySelector('#btnActivePause');
        if (btnPause) {
          btnPause.onclick = async () => {
            if (a.status === 'paused') {
              SM.resumeSession(a);
              this.onToast(t('sess.toast.resumed'));
            } else {
              SM.pauseSession(a);
              this.onToast(t('sess.toast.paused'));
            }
            await SM.saveActiveSession(this.origin, a);
            this.onSessionChange();
            this.render();
          };
        }
        const btnSaveSess = card.querySelector('#btnActiveSaveSession');
        if (btnSaveSess) {
          btnSaveSess.onclick = async () => {
            if (this.onSaveSession) { await this.onSaveSession(); if (this.isOpen) { await this.refreshData(); this.render(); } return; }
            if (a.saved_boxes === 0 && a.total_actions === 0) {
              this.onToast(t('sess.toast.empty')); return;
            }
            const fin = SM.finishSession(a, { cvatSaved: true, reason: 'saved' });
            await SM.appendCompletedSession(this.origin, fin);
            if (typeof SupaLog !== 'undefined' && SupaLog.pushSession) {
              SupaLog.pushSession(fin).catch(() => {});
            }
            this.onToast(t('sess.toast.saved', { id: fin.session_id.slice(0, 8), n: fin.saved_boxes, min: Math.round((fin.time_saved_seconds || 0) / 60) }));
            this.activeSession = SM.createSession({ jobId: a.job_id, origin: this.origin });
            await SM.saveActiveSession(this.origin, this.activeSession);
            await this.refreshData();
            this.render();
          };
        }
        card.querySelector('#btnActiveSave').onclick = () => {
          if (this.onCvatSave) this.onCvatSave();
          this.close();
        };
        card.querySelector('#btnActiveDetail').onclick = () => {
          this.selectedSessionId = a.session_id;
          this.currentTab = 'detail';
          this.render();
        };
        body.appendChild(card);
      }

      // 2. Danh sách phiên đã hoàn thành
      if (!this.sessions.length && !this.activeSession) {
        body.innerHTML = `
          <div class="sess-empty">
            <h2>${esc(t('sess.none.title'))}</h2>
            <p>${esc(t('sess.none.hint'))}</p>
          </div>
        `;
        return;
      }

      const listHd = document.createElement('div');
      listHd.className = 'sess-between';
      listHd.innerHTML = `
        <b>${esc(t('sess.done', { n: this.sessions.length }))}</b>
        <button class="sess-btn danger sm" id="btnClearAllSess">${esc(t('log.delall'))}</button>
      `;
      listHd.querySelector('#btnClearAllSess').onclick = async () => {
        if (!confirm(t('sess.delall.confirm'))) return;
        await SM.clearAll(this.origin);
        await this.refreshData();
        this.render();
      };
      body.appendChild(listHd);

      this.sessions.forEach((s) => {
        const card = document.createElement('div');
        card.className = 'sess-card';
        card.innerHTML = `
          <div class="sess-between">
            <span>
              <span class="sess-badge ${s.cvat_saved ? 'ok' : 'warn'}">${esc(t(s.cvat_saved ? 'sess.saved.cvat' : 'sess.unsaved'))}</span>${s.ended_reason ? ` <span class="sess-badge muted">${esc(t('sess.reason.' + s.ended_reason))}</span>` : ''} &nbsp;
              <b>${esc(t('sess.card.title', { id: s.session_id.slice(0, 8), job: s.job_id || '—' }))}</b>
            </span>
            <span class="sess-mono sess-muted">${fmtSec(s.duration_seconds)}</span>
          </div>
          <div class="sess-meta">
            <span>${esc(t('sess.lbl.started'))}: ${fmtTs(s.started_at)}</span>
            <span>${esc(t('sess.lbl.boxes'))}: <b class="sess-text">${s.saved_boxes}</b> ${esc(t('sess.card.boxsub', { tool: s.tool_count, manual: s.manual_count }))}</span>
            <span>${esc(t('sess.lbl.speed'))}: <b class="sess-ok">${s.avg_seconds_per_box_tool || s.avg_seconds_per_box_overall || 0}s/box</b></span>
            <span>${esc(t('sess.lbl.speedup'))}: <b class="sess-ok">${SM.metricsOf(s).speedup == null ? '—' : SM.metricsOf(s).speedup.toFixed(2) + '×'}</b></span>
            <span>${esc(t('sess.lbl.saved'))}: <b class="sess-text">${SM.metricsOf(s).timeSaved == null ? '—' : '~' + Math.round(SM.metricsOf(s).timeSaved / 60) + 'p'}</b></span>
          </div>
          <div class="sess-actions">
            <button class="sess-btn sm pri" data-action="detail" data-id="${esc(s.session_id)}">${esc(t('sess.btn.detail'))}</button>
            <button class="sess-btn sm" data-action="csv" data-id="${esc(s.session_id)}">${esc(t('log.download'))}</button>
            <button class="sess-btn sm" data-action="md" data-id="${esc(s.session_id)}">${esc(t('sess.md'))}</button>
            <span class="sess-sp" style="flex:1"></span>
            <button class="sess-btn sm danger" data-action="del" data-id="${esc(s.session_id)}">${esc(t('sess.del'))}</button>
          </div>
        `;

        card.querySelector('[data-action="detail"]').onclick = () => {
          this.selectedSessionId = s.session_id;
          this.currentTab = 'detail';
          this.render();
        };
        card.querySelector('[data-action="csv"]').onclick = () => this.exportSessionCsv(s);
        card.querySelector('[data-action="md"]').onclick = () => this.copySessionMarkdown(s);
        card.querySelector('[data-action="del"]').onclick = async () => {
          if (!confirm(t('sess.del.confirm', { id: s.session_id.slice(0, 8) }))) return;
          await SM.deleteSession(this.origin, s.session_id);
          await this.refreshData();
          this.render();
        };

        body.appendChild(card);
      });
    }

    renderSessionDetail(body) {
      const s = [...this.sessions, this.activeSession].find((x) => x && x.session_id === this.selectedSessionId) || this.sessions[0];
      if (!s) {
        body.innerHTML = `<p>${esc(t('sess.notfound'))}</p>`;
        return;
      }

      // Top bar in detail view
      const nav = document.createElement('div');
      nav.className = 'sess-detail-nav';
      nav.innerHTML = `
        <button class="sess-btn sm" id="btnBackToList">${esc(t('sess.back'))}</button>
        <b>${esc(t('sess.detail.title', { id: s.session_id.slice(0, 8), job: s.job_id }))}</b>
        <div class="sess-actions" style="margin:0">
          <button class="sess-btn sm pri" id="btnExportDetailCsv">${esc(t('log.download'))}</button>
          <button class="sess-btn sm" id="btnExportDetailMd">${esc(t('sess.md'))}</button>
        </div>
      `;
      nav.querySelector('#btnBackToList').onclick = () => { this.currentTab = 'sessions'; this.render(); };
      nav.querySelector('#btnExportDetailCsv').onclick = () => this.exportSessionCsv(s);
      nav.querySelector('#btnExportDetailMd').onclick = () => this.copySessionMarkdown(s);
      body.appendChild(nav);

      // Quantitative Comparison Table (Manual vs Tool)
      const matrix = document.createElement('div');
      matrix.className = 'sess-section';
      const mm = SM.metricsOf(s);
      matrix.innerHTML = `
        <div class="sess-section-hd">${esc(t('sess.matrix.title'))}</div>
        <table class="sess-table">
          <thead>
            <tr>
              <th>${esc(t('sess.mx.metric'))}</th>
              <th>${esc(t('sess.mx.manual'))}</th>
              <th>${esc(t('sess.mx.tool'))}</th>
              <th>${esc(t('sess.mx.gain'))}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>${esc(t('sess.r.boxes'))}</td>
              <td>${s.manual_count} box</td>
              <td>${s.tool_count} box</td>
              <td><b>${esc(t('sess.r.auto', { pct: s.saved_boxes ? ((s.tool_count / s.saved_boxes) * 100).toFixed(1) : 0 }))}</b></td>
            </tr>
            <tr>
              <td>${esc(t('sess.r.time'))}</td>
              <td>${mm.manualAvg == null ? '—' : mm.manualAvg.toFixed(1) + 's'}</td>
              <td>${mm.toolAvg == null ? '—' : mm.toolAvg.toFixed(1) + 's'}</td>
              <td>${mm.speedup == null ? '—' : `<b class="sess-ok">${esc(t('sess.r.faster', { v: mm.speedup.toFixed(2) }))}</b>`}</td>
            </tr>
            <tr>
              <td>${esc(t('sess.r.recheck'))}</td>
              <td>${esc(t('sess.r.recheck.manual'))}</td>
              <td>${esc(t('sess.r.recheck.tool', { pct: s.edit_rate_pct, e: s.edited_count, t: s.tool_count }))}</td>
              <td><b class="sess-ok">${esc(t('sess.r.kept', { pct: (100 - s.edit_rate_pct).toFixed(1) }))}</b></td>
            </tr>
            <tr>
              <td>${esc(t('sess.r.iou'))}</td>
              <td>${esc(t('sess.r.byhand'))}</td>
              <td>${s.avg_iou || '—'}</td>
              <td>${esc(t('sess.r.iou.gain'))}</td>
            </tr>
            <tr>
              <td>${esc(t('sess.r.yaw'))}</td>
              <td>${esc(t('sess.r.byhand2'))}</td>
              <td>${s.avg_yaw_deg ? s.avg_yaw_deg + '°' : '—'}</td>
              <td>${esc(t('sess.r.yaw.gain'))}</td>
            </tr>
            <tr class="sess-total">
              <td><b>${esc(t('sess.r.total'))}</b></td>
              <td>—</td>
              <td>—</td>
              <td><b class="sess-ok" style="font-size:14px;">${mm.timeSaved == null ? '—' : esc(t('sess.r.min', { min: Math.round(mm.timeSaved / 60) }))}</b></td>
            </tr>
          </tbody>
        </table>
      `;
      body.appendChild(matrix);

      // Raw Actions Table in this session
      const sessLogs = this.logs.filter((l) => l.session_id === s.session_id);
      const logSec = document.createElement('div');
      logSec.className = 'sess-section';
      logSec.innerHTML = `
        <div class="sess-section-hd">${esc(t('sess.log.title', { n: sessLogs.length }))}</div>
        <div class="sess-scroll">
          <table class="sess-table">
            <thead>
              <tr>
                <th>${esc(t('log.th.time'))}</th>
                <th>${esc(t('log.th.frame'))}</th>
                <th>${esc(t('log.th.camera'))}</th>
                <th>${esc(t('log.th.action'))}</th>
                <th>${esc(t('sess.lth.how'))}</th>
                <th>${esc(t('sess.lth.label'))}</th>
                <th>${esc(t('sess.lth.iou'))}</th>
                <th>${esc(t('sess.lth.yaw'))}</th>
                <th>${esc(t('log.th.edited'))}</th>
              </tr>
            </thead>
            <tbody>
              ${sessLogs.length ? sessLogs.map((l) => `
                <tr>
                  <td class="sess-mono">${esc(l.time?.slice(11, 19) || '—')}</td>
                  <td>${esc(l.frame ?? '—')}</td>
                  <td>${esc(l.camera || '—')}</td>
                  <td><span class="sess-badge ${l.action === 'save' ? 'ok' : 'muted'}">${esc(l.action)}</span></td>
                  <td><b>${esc(l.how || '—')}</b></td>
                  <td>${esc(l.label || l.labelName || '—')}</td>
                  <td class="sess-mono">${l.iou != null ? (+l.iou).toFixed(3) : '—'}</td>
                  <td class="sess-mono">${l.dyaw != null ? (+l.dyaw).toFixed(1) + '°' : (l.dyaw_deg != null ? (+l.dyaw_deg).toFixed(1) + '°' : '—')}</td>
                  <td>${l.edited == null ? '—' : l.edited ? `<span class="sess-badge warn">${esc(t('log.edited'))}</span>` : `<span class="sess-badge ok">${esc(t('log.kept'))}</span>`}</td>
                </tr>
              `).join('') : `<tr><td colspan="9" class="sess-empty-cell">${esc(t('sess.log.empty'))}</td></tr>`}
            </tbody>
          </table>
        </div>
      `;
      body.appendChild(logSec);
    }

    exportSessionCsv(s) {
      const sessLogs = this.logs.filter((l) => l.session_id === s.session_id);
      const COLS = ['time', 'session_id', 'job', 'frame', 'camera', 'action', 'how', 'label', 'time_spent_seconds', 'iou', 'dyaw_deg', 'edited'];
      const rows = [COLS.join(',')];
      sessLogs.forEach((l) => {
        rows.push([
          l.time || '', l.session_id || s.session_id, l.job || s.job_id, l.frame ?? '',
          l.camera || '', l.action || '', l.how || '', l.label || l.labelName || '',
          l.time_spent_seconds ?? '', l.iou ?? '', l.dyaw ?? l.dyaw_deg ?? '', l.edited ? 1 : 0
        ].map(EL.csvCell).join(','));
      });
      const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `session-${s.session_id.slice(0, 8)}-${s.job_id || 'cvat'}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      this.onToast(t('sess.toast.csv'));
    }

    copySessionMarkdown(s) {
      const md = SM.toMarkdownReport(s);
      navigator.clipboard.writeText(md).then(() => {
        this.onToast(t('sess.toast.md'));
      }).catch(() => {
        this.onToast(t('sess.toast.mdfail'));
      });
    }

    exportAllMarkdown() {
      const all = [...this.sessions];
      if (this.activeSession) all.unshift(this.activeSession);
      const agg = SM.aggregateSessions(all);

      const lines = [
        t('sess.md.title'),
        t('sess.md.sessions', { n: agg.total_sessions, done: agg.completed_sessions }),
        t('sess.md.boxes', { n: agg.total_saved_boxes, pct: agg.overall_tool_adoption_pct }),
        t('sess.md.saved', { min: agg.overall_speedup == null ? '—' : Math.round(agg.total_time_saved_seconds / 60), x: agg.overall_speedup == null ? '—' : agg.overall_speedup }),
        t('sess.md.quality', { iou: agg.overall_avg_iou || '—', yaw: agg.overall_avg_yaw_deg || '—' }),
        '',
        t('sess.md.each'),
        ''
      ];
      all.forEach((s) => lines.push(SM.toMarkdownReport(s)));

      navigator.clipboard.writeText(lines.join('\n')).then(() => {
        this.onToast(t('sess.toast.mdall'));
      });
    }
  }

  const api = { SessionPopupComponent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionPopup = api;
})(typeof self !== 'undefined' ? self : this);
