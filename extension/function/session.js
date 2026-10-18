/*
 * session.js — Quản lý vòng đời phiên gán nhãn & Thống kê định lượng (P-009)
 *
 * Định nghĩa:
 *  - Bắt đầu phiên (startSession): Khi mở extension overlay.
 *  - Trong phiên (recordAction): Ghi nhận thao tác, đo delta time giữa các box,
 *    phân loại Làm tay (Manual) vs Dùng Tool (Auto 3D / 3D Tracker), đo IoU, Yaw error.
 *  - Kết thúc phiên (finishSession): Khi đóng panel và CVAT lưu thành công.
 *  - Tổng hợp chỉ số (aggregateSessions): Thống kê đa phiên, tính tỷ lệ tăng tốc (speedup),
 *    thời gian tiết kiệm được, phân bổ IoU, năng suất theo lớp đối tượng.
 */
(function (root) {
  'use strict';

  const IDLE_THRESHOLD_SEC = 120;           // Khoảng nghỉ > 2 phút tính là idle
  const ACTION_CAP_SEC = 25;                // thời gian tính cho một thao tác sau khoảng nghỉ dài (máy treo)
  const STALE_SEC = 600;                    // phiên "active" không có hoạt động quá 10 phút = bị bỏ dở (đóng tab / crash)
  /** Tham số tính giờ và ngưỡng "box đã sửa" của phiên, lưu cùng phiên để ghi vào phần phương pháp của báo cáo.
   *  grace_sec / panel_grace_sec / edit_* trùng compare.js và editlog.js (cvat.js truyền giá trị thật khi tạo phiên). */
  const DEFAULT_PARAMS = { idle_sec: IDLE_THRESHOLD_SEC, grace_sec: 5, panel_grace_sec: 60, action_cap_sec: ACTION_CAP_SEC, edit_iou: 0.9, edit_yaw_deg: 5 };
  const SESSIONS_PREFIX = 'sessions:';
  const ACTIVE_PREFIX = 'active_session:';

  function genId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  /** Khởi tạo phiên làm việc mới khi mở extension */
  function createSession(opts = {}) {
    const now = Date.now();
    const id = opts.sessionId || genId();
    return {
      session_id: id,
      origin: opts.origin || (typeof location !== 'undefined' ? location.origin : 'local'),
      job_id: opts.jobId != null ? String(opts.jobId) : '',
      task_name: '',                     // không lưu tên task (có thể mang tên dataset / scene)
      start_frame: opts.frame ?? null,
      started_at: opts.startedAt || new Date(now).toISOString(),
      ended_at: null,
      start_ts: now,
      last_action_ts: now,
      status: 'active',                  // 'active' | 'paused' | 'completed'
      ended_reason: null,                // 'saved' (nút Lưu phiên) | 'exit' (thoát và lưu) | 'stale' (phiên bỏ dở được lưu)
      resumed_count: 0,                  // số lần tiếp tục phiên này ở lần mở sau
      last_activity_ts: now,
      last_activity_at: new Date(now).toISOString(),
      frame_times: {},                   // { "<chỉ số frame>": { tool_s, manual_s, panel_s, boxes } }
      tracks_created: 0,
      params: { ...DEFAULT_PARAMS, ...(opts.params || {}) },
      cvat_saved: false,

      duration_seconds: 0,
      active_seconds: 0,

      total_actions: 0,
      saved_boxes: 0,
      skipped_proposals: 0,
      frames_annotated: [],

      manual_count: 0,
      tool_count: 0,
      manual_time_seconds: 0,
      tool_time_seconds: 0,

      tool_breakdown: {
        auto_3d: 0,     // 'T'
        tracker_3d: 0,  // 'lan' | 'tracker'
        learned: 0,     // 'learned'
        click_fit: 0,   // click to fit
        semi_auto: 0    // N in the extension: a rectangle drawn on the 2D image, the machine fits the 3D box
      },

      edited_count: 0,
      unchanged_count: 0,
      iou_sum: 0,
      iou_count: 0,
      yaw_err_sum: 0,
      yaw_err_count: 0,

      paused_at: null,
      total_paused_seconds: 0,
      class_stats: {},

      // Các chỉ số tính toán khi kết thúc
      avg_seconds_per_box_overall: 0,
      avg_seconds_per_box_manual: null,
      avg_seconds_per_box_tool: 0,
      speedup_factor: null,
      time_saved_seconds: 0,
      edit_rate_pct: 0,
      avg_iou: 0,
      avg_yaw_deg: 0,
      iou_hist: { high: 0, mid: 0, low: 0 }      // IoU của box tool lưu so với đề xuất máy: >= 0.9 / 0.7-0.9 / < 0.7
    };
  }

  const frameRow = (session, frame) => {
    if (frame == null || frame === '') return null;
    const ft = (session.frame_times ||= {});
    return (ft[frame] ||= { tool_s: 0, manual_s: 0, panel_s: 0, boxes: 0 });
  };
  const r1 = (v) => +v.toFixed(1);
  /** Có hoạt động của người dùng lúc nowMs (dùng để nhận ra phiên bị bỏ dở). */
  function touch(session, nowMs = Date.now()) {
    session.last_activity_ts = nowMs;
    session.last_activity_at = new Date(nowMs).toISOString();
    return session;
  }

  /** Làm tay trực tiếp trong CVAT (đo ngoài extension, compare.js): cộng vào số liệu làm tay của phiên
   *  nhưng không tính vào số box lưu qua extension (saved_boxes). */
  function addManual(session, seconds, count, frame = null, nowMs = Date.now()) {
    if (!session || !(seconds > 0 || count > 0)) return session;
    const fr = frameRow(session, frame);
    if (fr && seconds > 0) fr.manual_s = r1(fr.manual_s + seconds);
    if (seconds > 0) touch(session, nowMs);
    session.manual_time_seconds = +((session.manual_time_seconds || 0) + seconds).toFixed(1);
    session.manual_count = (session.manual_count || 0) + count;
    session.native_manual_seconds = +((session.native_manual_seconds || 0) + seconds).toFixed(1);
    session.native_manual_count = (session.native_manual_count || 0) + count;
    return session;
  }

  /** Thời gian mở panel extension và đang làm việc trong đó (label 2D, kể cả lúc không chạy model): tính từ lúc mở,
   *  không chỉ khoảng giữa các lần lưu box. compare.js đo, cvat.js đưa vào đây. */
  function addPanel(session, seconds, frame = null, nowMs = Date.now()) {
    if (!session || !(seconds > 0)) return session;
    const fr = frameRow(session, frame);
    if (fr) fr.panel_s = r1(fr.panel_s + seconds);
    touch(session, nowMs);
    session.panel_seconds = +((session.panel_seconds || 0) + seconds).toFixed(1);
    return session;
  }

  /** Tạm dừng phiên làm việc (nghỉ ngơi, hội ý) */
  function pauseSession(session, nowMs = Date.now()) {
    if (!session || session.status !== 'active') return session;
    session.status = 'paused';
    session.paused_at = nowMs;
    return session;
  }

  /** Phiên "active" bị bỏ dở (đóng tab, crash, máy treo): coi như tạm dừng đúng lúc hoạt động cuối. Thời gian vắng sau đó rơi vào
   *  total_paused_seconds khi tiếp tục / kết thúc, nên không tính vào thời gian làm việc. Trả về true nếu có đổi. */
  function settleStale(session, nowMs = Date.now(), staleSec = STALE_SEC) {
    if (!session || session.status !== 'active') return false;
    const last = session.last_activity_ts || session.last_action_ts || session.start_ts || nowMs;
    if (nowMs - last <= staleSec * 1000) return false;
    session.status = 'paused';
    session.paused_at = last;
    session.stale = true;
    return true;
  }

  /** Tiếp tục phiên làm việc sau khi tạm dừng */
  function resumeSession(session, nowMs = Date.now()) {
    if (!session || session.status !== 'paused') return session;
    if (session.paused_at) {
      const pauseSec = Math.max(0, (nowMs - session.paused_at) / 1000);
      session.total_paused_seconds = +( (session.total_paused_seconds || 0) + pauseSec ).toFixed(1);
    }
    session.status = 'active';
    session.paused_at = null;
    session.last_action_ts = nowMs; // Reset mốc tính delta time từ thời điểm resume
    touch(session, nowMs);
    return session;
  }

  /** Tiếp tục một phiên cũ ở lần mở sau (khác với bấm Tạm dừng / Tiếp tục trong lúc làm): đếm resumed_count. */
  function resumeFromPrevious(session, nowMs = Date.now()) {
    if (!session) return session;
    if (session.status === 'paused') resumeSession(session, nowMs);
    else touch(session, nowMs);
    session.resumed_count = (session.resumed_count || 0) + 1;
    delete session.stale;
    return session;
  }

  /**
   * Ghi nhận 1 thao tác vào phiên đang mở.
   * Tính delta time từ thao tác trước tới thao tác này.
   */
  function recordAction(session, rec, nowMs = Date.now()) {
    if (!session) return rec;
    if (session.status === 'paused') {
      resumeSession(session, nowMs);
    }
    if (session.status !== 'active') return rec;

    let dt = (nowMs - (session.last_action_ts || session.start_ts)) / 1000;
    if (dt > ((session.params && session.params.idle_sec) || IDLE_THRESHOLD_SEC)) {
      dt = (session.params && session.params.action_cap_sec) || ACTION_CAP_SEC; // Giới hạn nếu người dùng để máy treo (idle)
    } else if (dt < 0.2) {
      dt = 0.5;
    }
    const timeSpent = +dt.toFixed(1);

    session.active_seconds = +(session.active_seconds + timeSpent).toFixed(1);
    session.last_action_ts = nowMs;
    touch(session, nowMs);
    session.total_actions++;
    const fr = frameRow(session, rec.frame);
    if (fr) { fr.tool_s = r1(fr.tool_s + timeSpent); if (rec.action === 'save') fr.boxes++; }

    rec.session_id = session.session_id;
    rec.time_spent_seconds = timeSpent;

    if (rec.action === 'save') {
      session.saved_boxes++;
      if (rec.frame != null && !session.frames_annotated.includes(rec.frame)) {
        session.frames_annotated.push(rec.frame);
      }

      // Everything saved through the extension is tool, N (how 'tay') included: semi-auto. Manual is only what is drawn in CVAT
      // itself (addManual).
      const isManual = false;
      if (isManual) {
        session.manual_count++;
        session.manual_time_seconds = +(session.manual_time_seconds + timeSpent).toFixed(1);
      } else {
        session.tool_count++;
        session.tool_time_seconds = +(session.tool_time_seconds + timeSpent).toFixed(1);

        if (rec.how === 'T') session.tool_breakdown.auto_3d++;
        else if (rec.how === 'lan' || rec.how === 'tracker') session.tool_breakdown.tracker_3d++;
        else if (rec.how === 'learned') session.tool_breakdown.learned++;
        else if (rec.how === 'tay') session.tool_breakdown.semi_auto++;
        else session.tool_breakdown.click_fit++;

        if (rec.edited) session.edited_count++;
        else session.unchanged_count++;

        if (rec.iou != null && !isNaN(rec.iou)) {
          session.iou_sum += rec.iou;
          session.iou_count++;
          const h = (session.iou_hist ||= { high: 0, mid: 0, low: 0 });
          h[rec.iou >= 0.9 ? 'high' : rec.iou >= 0.7 ? 'mid' : 'low']++;
        }
        const dyaw = rec.dyaw != null ? rec.dyaw : (rec.dyaw_deg != null ? rec.dyaw_deg : null);
        if (dyaw != null && !isNaN(dyaw)) {
          session.yaw_err_sum += Math.abs(dyaw);
          session.yaw_err_count++;
        }
      }

      // Thống kê theo lớp
      const lbl = rec.label || rec.labelName || 'unknown';
      let cs = session.class_stats[lbl];
      if (!cs) {
        cs = session.class_stats[lbl] = {
          count: 0, manual_count: 0, tool_count: 0,
          time_seconds: 0, iou_sum: 0, iou_count: 0, unchanged: 0
        };
      }
      cs.count++;
      cs.time_seconds = +(cs.time_seconds + timeSpent).toFixed(1);
      if (isManual) cs.manual_count++;
      else {
        cs.tool_count++;
        if (!rec.edited) cs.unchanged++;
        if (rec.iou != null) { cs.iou_sum += rec.iou; cs.iou_count++; }
      }
    } else if (rec.action === 'skip') {
      session.skipped_proposals++;
    }

    return rec;
  }

  /** Derived numbers of one session, from the raw counters only (also right for sessions saved by older versions, whose stored
   *  speed-up used a fixed 45 s manual baseline). null = not measured. */
  function metricsOf(s) {
    const manualAvg = s.manual_count > 0 && s.manual_time_seconds > 0 ? s.manual_time_seconds / s.manual_count : null;
    const toolAvg = s.tool_count > 0 && s.tool_time_seconds > 0 ? s.tool_time_seconds / s.tool_count : null;
    const speedup = manualAvg && toolAvg ? manualAvg / toolAvg : null;
    return {
      manualAvg, toolAvg, speedup,
      timeSaved: speedup ? Math.max(0, (manualAvg - toolAvg) * s.tool_count) : null,
      editRate: s.tool_count > 0 ? 100 * (s.edited_count || 0) / s.tool_count : null,
      avgIou: s.iou_count > 0 ? s.iou_sum / s.iou_count : null,
      avgYaw: s.yaw_err_count > 0 ? s.yaw_err_sum / s.yaw_err_count : null,
    };
  }

  /** Thời gian làm việc ròng của phiên (không tính lúc tạm dừng, kể cả lúc đang tạm dừng). */
  function netDuration(session, nowMs) {
    let paused = session.total_paused_seconds || 0;
    if (session.status === 'paused' && session.paused_at) paused += Math.max(0, (nowMs - session.paused_at) / 1000);
    const end = session.ended_at ? Date.parse(session.ended_at) : nowMs;
    return Math.max(1, Math.round((end - session.start_ts) / 1000 - paused));
  }
  /** Các số suy ra từ bộ đếm gốc (không đổi trạng thái phiên). */
  function deriveFields(session, nowMs) {
    session.duration_seconds = netDuration(session, nowMs);
    session.active_seconds = +session.active_seconds.toFixed(1);
    session.avg_seconds_per_box_overall = session.saved_boxes > 0 ? +(session.active_seconds / session.saved_boxes).toFixed(1) : 0;

    // Only measured numbers: without a manual measurement (compare clock) there is no manual baseline, hence no speed-up.
    const m = metricsOf(session);
    session.avg_seconds_per_box_manual = m.manualAvg == null ? null : +m.manualAvg.toFixed(1);
    session.avg_seconds_per_box_tool = m.toolAvg == null ? 0 : +m.toolAvg.toFixed(1);
    session.speedup_factor = m.speedup == null ? null : +m.speedup.toFixed(2);
    session.time_saved_seconds = m.timeSaved == null ? 0 : Math.round(m.timeSaved);   // 0 together with speedup_factor null = unknown
    session.edit_rate_pct = m.editRate == null ? 0 : +m.editRate.toFixed(1);
    session.avg_iou = session.iou_count > 0 ? +(session.iou_sum / session.iou_count).toFixed(3) : 0;
    session.avg_yaw_deg = session.yaw_err_count > 0 ? +(session.yaw_err_sum / session.yaw_err_count).toFixed(1) : 0;
    for (const cs of Object.values(session.class_stats || {})) {
      cs.avg_seconds = cs.count > 0 ? +(cs.time_seconds / cs.count).toFixed(1) : 0;
      cs.avg_iou = cs.iou_count > 0 ? +(cs.iou_sum / cs.iou_count).toFixed(3) : 0;
      cs.unchanged_pct = cs.tool_count > 0 ? +((cs.unchanged / cs.tool_count) * 100).toFixed(1) : 0;
    }
    return session;
  }
  /** Bản sao của phiên đang mở kèm các số suy ra đến lúc này (để đẩy một phần lên Supabase khi tạm dừng); phiên gốc không đổi. */
  function snapshot(session, nowMs = Date.now()) {
    if (!session) return null;
    return deriveFields(JSON.parse(JSON.stringify(session)), nowMs);
  }

  /** Chốt phiên. opts.reason: 'saved' (nút Lưu phiên, mặc định) | 'exit' (thoát và lưu) | 'stale' (phiên bỏ dở được lưu). */
  function finishSession(session, opts = {}, nowMs = Date.now()) {
    if (!session) return null;
    if (session.status === 'paused' && session.paused_at) {
      const pauseSec = Math.max(0, (nowMs - session.paused_at) / 1000);
      session.total_paused_seconds = +( (session.total_paused_seconds || 0) + pauseSec ).toFixed(1);
      session.paused_at = null;
    }
    session.ended_at = new Date(nowMs).toISOString();
    session.status = 'completed';
    session.ended_reason = opts.reason || (session.stale ? 'stale' : 'saved');
    session.cvat_saved = opts.cvatSaved !== false;
    delete session.stale;
    return deriveFields(session, nowMs);
  }

  /**
   * Tổng hợp nhiều phiên thành Dashboard Analytics đa phiên
   */
  function aggregateSessions(sessions = []) {
    const valid = sessions.filter((s) => s && s.saved_boxes > 0);
    const agg = {
      total_sessions: sessions.length,
      completed_sessions: sessions.filter((s) => s.status === 'completed').length,
      total_duration_seconds: 0,
      total_active_seconds: 0,
      total_saved_boxes: 0,
      total_manual_boxes: 0,
      total_tool_boxes: 0,
      total_time_saved_seconds: 0,
      overall_speedup: null,                 // null: no manual measurement yet
      avg_tool_seconds: null,
      has_manual_baseline: false,
      overall_tool_adoption_pct: 0,
      overall_avg_iou: 0,
      overall_avg_yaw_deg: 0,
      overall_unchanged_pct: 0,

      // Dữ liệu vẽ biểu đồ xu hướng tốc độ
      speed_trend: [],
      // Cơ cấu phương pháp
      method_breakdown: { tracker: 0, auto: 0, manual: 0, learned: 0, click_fit: 0, semi_auto: 0 },
      // Phân bổ IoU
      iou_histogram: { high: 0, mid: 0, low: 0 },
      // Phân tích theo lớp
      class_summary: {}
    };

    let totalIouSum = 0, totalIouCnt = 0;
    let totalYawSum = 0, totalYawCnt = 0;
    let totalToolTime = 0, totalManualTime = 0;
    let totalUnchanged = 0;

    for (const s of sessions) {
      agg.total_duration_seconds += s.duration_seconds || 0;
      agg.total_active_seconds += s.active_seconds || 0;
      agg.total_saved_boxes += s.saved_boxes || 0;
      agg.total_manual_boxes += s.manual_count || 0;
      agg.total_tool_boxes += s.tool_count || 0;
      const sm = metricsOf(s);
      if (sm.timeSaved != null) agg.total_time_saved_seconds += sm.timeSaved;

      totalManualTime += s.manual_time_seconds || 0;
      totalToolTime += s.tool_time_seconds || 0;
      if (s.iou_hist) for (const k of ['high', 'mid', 'low']) agg.iou_histogram[k] += s.iou_hist[k] || 0;

      totalIouSum += s.iou_sum || 0;
      totalIouCnt += s.iou_count || 0;
      totalYawSum += s.yaw_err_sum || 0;
      totalYawCnt += s.yaw_err_count || 0;
      totalUnchanged += s.unchanged_count || 0;

      if (s.tool_breakdown) {
        agg.method_breakdown.tracker += s.tool_breakdown.tracker_3d || 0;
        agg.method_breakdown.auto += s.tool_breakdown.auto_3d || 0;
        agg.method_breakdown.learned += s.tool_breakdown.learned || 0;
        agg.method_breakdown.click_fit += s.tool_breakdown.click_fit || 0;
        agg.method_breakdown.semi_auto += s.tool_breakdown.semi_auto || 0;
      }
      agg.method_breakdown.manual += s.manual_count || 0;

      // Điểm dữ liệu cho biểu đồ xu hướng
      if (s.saved_boxes > 0) {
        agg.speed_trend.push({
          session_id: s.session_id,
          date: s.started_at ? s.started_at.slice(5, 16).replace('T', ' ') : '—',
          manual_speed: sm.manualAvg == null ? null : +sm.manualAvg.toFixed(1),
          tool_speed: s.avg_seconds_per_box_tool || (s.avg_seconds_per_box_overall || 0),
          speedup: sm.speedup == null ? null : +sm.speedup.toFixed(2),
          boxes: s.saved_boxes
        });
      }

      // Gom lớp
      if (s.class_stats) {
        for (const [name, cs] of Object.entries(s.class_stats)) {
          let row = agg.class_summary[name];
          if (!row) {
            row = agg.class_summary[name] = {
              name, count: 0, tool_count: 0, manual_count: 0,
              time_seconds: 0, iou_sum: 0, iou_count: 0, unchanged: 0
            };
          }
          row.count += cs.count;
          row.tool_count += cs.tool_count;
          row.manual_count += cs.manual_count;
          row.time_seconds += cs.time_seconds;
          row.iou_sum += cs.iou_sum || 0;
          row.iou_count += cs.iou_count || 0;
          row.unchanged += cs.unchanged || 0;
        }
      }
    }

    if (agg.total_saved_boxes > 0) {
      agg.overall_tool_adoption_pct = +((agg.total_tool_boxes / agg.total_saved_boxes) * 100).toFixed(1);
    }
    if (agg.total_tool_boxes > 0 && totalToolTime > 0) {
      const avgTool = totalToolTime / agg.total_tool_boxes;
      agg.avg_tool_seconds = +avgTool.toFixed(1);
      if (agg.total_manual_boxes > 0 && totalManualTime > 0) {
        agg.has_manual_baseline = true;
        agg.overall_speedup = +((totalManualTime / agg.total_manual_boxes) / avgTool).toFixed(2);
      }
      agg.overall_unchanged_pct = +((totalUnchanged / agg.total_tool_boxes) * 100).toFixed(1);
    }
    if (totalIouCnt > 0) {
      agg.overall_avg_iou = +(totalIouSum / totalIouCnt).toFixed(3);
    }
    if (totalYawCnt > 0) {
      agg.overall_avg_yaw_deg = +(totalYawSum / totalYawCnt).toFixed(1);
    }

    // Hoàn tất bảng lớp
    for (const r of Object.values(agg.class_summary)) {
      r.avg_seconds = r.count > 0 ? +(r.time_seconds / r.count).toFixed(1) : 0;
      r.avg_iou = r.iou_count > 0 ? +(r.iou_sum / r.iou_count).toFixed(3) : 0;
      r.tool_adoption_pct = r.count > 0 ? +((r.tool_count / r.count) * 100).toFixed(1) : 0;
      r.unchanged_pct = r.tool_count > 0 ? +((r.unchanged / r.tool_count) * 100).toFixed(1) : 0;
    }

    return agg;
  }

  // ── Local Storage Engine ──────────────────────────────────────────────────

  const storageKey = (origin) => `${SESSIONS_PREFIX}${origin || 'global'}`;
  const activeKey  = (origin) => `${ACTIVE_PREFIX}${origin || 'global'}`;

  async function loadSessions(origin) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return [];
    try {
      const k = storageKey(origin);
      const res = await chrome.storage.local.get(k);
      return Array.isArray(res[k]) ? res[k] : [];
    } catch {
      return [];
    }
  }

  async function saveSessions(origin, list) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
      const k = storageKey(origin);
      // Giữ tối đa 100 phiên gần nhất
      const trimmed = list.slice(0, 100);
      await chrome.storage.local.set({ [k]: trimmed });
    } catch (e) {
      console.warn('[Session] save failed', e);
    }
  }

  async function loadActiveSession(origin) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
    try {
      const k = activeKey(origin);
      const res = await chrome.storage.local.get(k);
      return res[k] || null;
    } catch {
      return null;
    }
  }

  async function saveActiveSession(origin, session) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
      const k = activeKey(origin);
      if (session) await chrome.storage.local.set({ [k]: session });
      else await chrome.storage.local.remove(k);
    } catch (e) {
      console.warn('[Session] saveActive failed', e);
    }
  }

  async function appendCompletedSession(origin, session) {
    const list = await loadSessions(origin);
    const idx = list.findIndex((s) => s.session_id === session.session_id);
    if (idx >= 0) list[idx] = session;
    else list.unshift(session);
    await saveSessions(origin, list);
    await saveActiveSession(origin, null);
  }

  async function deleteSession(origin, sessionId) {
    const list = await loadSessions(origin);
    const next = list.filter((s) => s.session_id !== sessionId);
    await saveSessions(origin, next);
  }

  async function clearAll(origin) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    await chrome.storage.local.remove([storageKey(origin), activeKey(origin)]);
  }

  // ── Export Định Lượng Chuẩn Báo Cáo P-009 ─────────────────────────────────

  function toMarkdownReport(session) {
    if (!session) return '';
    const m = metricsOf(session), dash = '—';
    const durM = Math.floor(session.duration_seconds / 60), durS = session.duration_seconds % 60;
    const fx = (v, d = 1) => (v == null ? dash : v.toFixed(d));
    return [
      `### Báo Cáo Định Lượng Phiên Gán Nhãn #${session.session_id.slice(0, 8)}`,
      `- **Thời gian**: ${session.started_at?.replace('T', ' ').slice(0, 19)} (Thời lượng: ${durM}m ${durS}s)`,
      `- **Job CVAT**: #${session.job_id} | **Tổng box**: ${session.saved_boxes} (Dùng Tool: ${session.tool_count}, Làm tay: ${session.manual_count})`,
      `- **Trạng thái**: ${session.status || dash}${session.ended_reason ? ` (${session.ended_reason})` : ''}`,
      '',
      '| Chỉ số đo đạc | Làm tay (Manual) | Dùng Tool | So sánh |',
      '|---|---|---|---|',
      `| Số lượng box | ${session.manual_count} | ${session.tool_count} | ${session.saved_boxes ? ((session.tool_count / session.saved_boxes) * 100).toFixed(1) : 0}% qua tool |`,
      `| Thời gian trung bình / box | ${m.manualAvg == null ? dash : fx(m.manualAvg) + 's'} | ${m.toolAvg == null ? dash : fx(m.toolAvg) + 's'} | ${m.speedup == null ? dash : 'nhanh hơn ' + fx(m.speedup, 2) + '×'} |`,
      `| Tỉ lệ box phải sửa (so với đề xuất máy) | ${dash} | ${m.editRate == null ? dash : fx(m.editRate) + '% (' + session.edited_count + '/' + session.tool_count + ')'} | ${dash} |`,
      `| IoU 3D với đề xuất máy | ${dash} | ${m.avgIou == null ? dash : fx(m.avgIou, 3)} | chưa so với GT |`,
      `| Lệch góc yaw với đề xuất máy | ${dash} | ${m.avgYaw == null ? dash : fx(m.avgYaw) + '°'} | chưa so với GT |`,
      ''
    ].join('\n');
  }

  const api = {
    metricsOf,
    snapshot,
    settleStale,
    resumeFromPrevious,
    touch,
    STALE_SEC,
    DEFAULT_PARAMS,
    createSession,
    recordAction,
    addManual,
    addPanel,
    pauseSession,
    resumeSession,
    finishSession,
    aggregateSessions,
    loadSessions,
    saveSessions,
    loadActiveSession,
    saveActiveSession,
    appendCompletedSession,
    deleteSession,
    clearAll,
    toMarkdownReport
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionManager = api;
})(typeof self !== 'undefined' ? self : this);
