// node tests/session.test.js — kiểm thử tính năng quản lý phiên và các chỉ số định lượng
const assert = require('assert');
const SM = require('../extension/function/session.js');

let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (e) {
    console.error('FAIL ' + name, e);
    fail++;
  }
}

test('createSession khởi tạo đúng schema', () => {
  const s = SM.createSession({ jobId: 18126, frame: 5, origin: 'https://app.cvat.ai' });
  assert.equal(s.job_id, '18126');
  assert.equal(s.start_frame, 5);
  assert.equal(s.status, 'active');
  assert.equal(s.saved_boxes, 0);
  assert.equal(s.total_actions, 0);
  assert.ok(s.session_id.length > 5);
});

test('recordAction tính delta time và phân loại Manual vs Tool', () => {
  const s = SM.createSession({ jobId: 18126 });
  const t0 = s.start_ts;

  // Box 1: N trong extension (how 'tay') = bán tự động, tính là Tool; Manual chỉ là làm tay trong CVAT (addManual)
  const r1 = SM.recordAction(s, { action: 'save', how: 'tay', label: 'car', frame: 5 }, t0 + 10000);
  assert.equal(r1.time_spent_seconds, 10);
  assert.equal(s.manual_count, 0);
  assert.equal(s.tool_count, 1);
  assert.equal(s.tool_breakdown.semi_auto, 1);
  assert.equal(s.saved_boxes, 1);

  // Box 2: Dùng 3D Tracker (lan), sau 4s, giữ nguyên (edited = false, iou = 0.95, dyaw = 1.2)
  const r2 = SM.recordAction(s, {
    action: 'save', how: 'lan', label: 'car', frame: 6,
    edited: false, iou: 0.95, dyaw: 1.2
  }, t0 + 14000);
  assert.equal(r2.time_spent_seconds, 4);
  assert.equal(s.manual_count, 0);
  assert.equal(s.tool_count, 2);
  assert.equal(s.tool_breakdown.tracker_3d, 1);
  assert.equal(s.unchanged_count, 2);
  assert.equal(s.edited_count, 0);

  // Box 3: Auto 3D (T), sau 6s, phải sửa (edited = true, iou = 0.82, dyaw = 5.5)
  const r3 = SM.recordAction(s, {
    action: 'save', how: 'T', label: 'truck', frame: 6,
    edited: true, iou: 0.82, dyaw: 5.5
  }, t0 + 20000);
  assert.equal(r3.time_spent_seconds, 6);
  assert.equal(s.tool_count, 3);
  assert.equal(s.tool_breakdown.auto_3d, 1);
  assert.equal(s.edited_count, 1);
  assert.equal(s.unchanged_count, 2);

  // Box 4: Bỏ qua (skip)
  const r4 = SM.recordAction(s, { action: 'skip', how: 'T', frame: 7 }, t0 + 22000);
  assert.equal(s.skipped_proposals, 1);
  assert.equal(s.saved_boxes, 3);
  assert.equal(s.total_actions, 4);
});

test('finishSession tính toán đúng tỷ lệ tăng tốc và thời gian tiết kiệm', () => {
  const s = SM.createSession({ jobId: 18126 });
  const t0 = s.start_ts;

  // 1 box làm tay 60s trong CVAT (đo ngoài extension)
  SM.addManual(s, 60, 1);

  // 4 box dùng tool: mỗi box 15s (tổng 60s)
  SM.recordAction(s, { action: 'save', how: 'lan', label: 'car', frame: 2, edited: false, iou: 0.92, dyaw: 1.0 }, t0 + 15000);
  SM.recordAction(s, { action: 'save', how: 'lan', label: 'car', frame: 3, edited: false, iou: 0.94, dyaw: 0.8 }, t0 + 30000);
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 4, edited: false, iou: 0.91, dyaw: 1.5 }, t0 + 45000);
  SM.recordAction(s, { action: 'save', how: 'T', label: 'truck', frame: 5, edited: true, iou: 0.85, dyaw: 4.2 }, t0 + 60000);

  const fin = SM.finishSession(s, { cvatSaved: true }, t0 + 60000);
  assert.equal(fin.status, 'completed');
  assert.equal(fin.cvat_saved, true);
  assert.equal(fin.manual_count, 1);
  assert.equal(fin.tool_count, 4);
  assert.equal(fin.saved_boxes, 4);

  // Manual: 60s / box; Tool: 60s / 4 = 15s / box
  assert.equal(fin.avg_seconds_per_box_manual, 60);
  assert.equal(fin.avg_seconds_per_box_tool, 15);

  // Speedup: 60 / 15 = 4.0x
  assert.equal(fin.speedup_factor, 4.0);

  // Thời gian tiết kiệm: 4 * (60 - 15) = 180s
  assert.equal(fin.time_saved_seconds, 180);

  // Tỷ lệ sửa: 1/4 = 25%
  assert.equal(fin.edit_rate_pct, 25.0);

  // Mean IoU = (0.92 + 0.94 + 0.91 + 0.85) / 4 = 0.905
  assert.equal(fin.avg_iou, 0.905);

  // Class stats
  assert.ok(fin.class_stats.car);
  assert.equal(fin.class_stats.car.count, 3);        // the manual box was made in CVAT (addManual): no class
  assert.ok(fin.class_stats.truck);
  assert.equal(fin.class_stats.truck.count, 1);
});

test('aggregateSessions tổng hợp đa phiên chính xác', () => {
  const s1 = SM.finishSession(SM.createSession({ jobId: 1 }), { cvatSaved: true });
  s1.saved_boxes = 10;
  s1.manual_count = 2;
  s1.tool_count = 8;
  s1.manual_time_seconds = 100; // 50s/box
  s1.tool_time_seconds = 160;   // 20s/box
  s1.avg_seconds_per_box_manual = 50;
  s1.avg_seconds_per_box_tool = 20;
  s1.time_saved_seconds = 240;
  s1.speedup_factor = 2.5;
  s1.iou_sum = 7.2;
  s1.iou_count = 8;
  s1.tool_breakdown = { auto_3d: 3, tracker_3d: 5, learned: 0, click_fit: 0 };
  s1.class_stats = {
    car: { count: 8, tool_count: 6, manual_count: 2, time_seconds: 200, iou_sum: 5.4, iou_count: 6, unchanged: 5 },
    ped: { count: 2, tool_count: 2, manual_count: 0, time_seconds: 60, iou_sum: 1.8, iou_count: 2, unchanged: 1 }
  };

  const agg = SM.aggregateSessions([s1]);
  assert.equal(agg.total_sessions, 1);
  assert.equal(agg.total_saved_boxes, 10);
  assert.equal(agg.overall_tool_adoption_pct, 80.0);
  assert.equal(agg.overall_speedup, 2.5);
  assert.equal(agg.overall_avg_iou, 0.900);
  assert.equal(agg.method_breakdown.tracker, 5);
  assert.equal(agg.method_breakdown.auto, 3);
  assert.ok(agg.class_summary.car);
  assert.equal(agg.class_summary.car.count, 8);
});

test('pauseSession và resumeSession trừ đúng thời gian nghỉ', () => {
  const s = SM.createSession({ jobId: 18126 });
  const t0 = s.start_ts;

  // Làm việc 10s -> lưu 1 box
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 1, iou: 0.95 }, t0 + 10000);

  // Tạm dừng 10 phút (600 giây)
  SM.pauseSession(s, t0 + 10000);
  assert.equal(s.status, 'paused');

  // Tiếp tục phiên sau 600s
  SM.resumeSession(s, t0 + 610000);
  assert.equal(s.status, 'active');
  assert.equal(s.total_paused_seconds, 600);

  // Làm việc tiếp 15s -> lưu box thứ 2
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 2, iou: 0.94 }, t0 + 625000);

  // Chốt phiên lúc t0 + 625000:
  // Tổng thời gian trôi qua = 625s. Đã pause 600s -> duration thực tế = 25s
  const fin = SM.finishSession(s, { cvatSaved: true }, t0 + 625000);
  assert.equal(fin.duration_seconds, 25);
  assert.equal(fin.saved_boxes, 2);
  assert.equal(fin.status, 'completed');
});

test('toMarkdownReport tạo bảng Markdown đúng định dạng', () => {
  const s = SM.createSession({ jobId: 18126 });
  s.saved_boxes = 20;
  s.manual_count = 4;
  s.tool_count = 16;
  s.manual_time_seconds = 260;      // 65 s / box
  s.tool_time_seconds = 288;        // 18 s / box
  s.edited_count = 2;               // 2 / 16 = 12.5%
  s.iou_sum = 0.932 * 16; s.iou_count = 16;
  s.yaw_err_sum = 1.4 * 16; s.yaw_err_count = 16;
  s.duration_seconds = 600;
  s.status = 'completed';

  const md = SM.toMarkdownReport(s);
  assert.ok(md.includes('Làm tay (Manual)'));
  assert.ok(md.includes('Dùng Tool'));
  assert.ok(md.includes('nhanh hơn 3.61×'));
  assert.ok(md.includes('chưa so với GT'));
  assert.ok(md.includes('12.5%'));
});

test('finishSession cấu trúc đầy đủ các trường đồng bộ lên bảng annotation_sessions', () => {
  const s = SM.createSession({ jobId: 18126, taskName: 'nuScenes-scene-0001' });
  const t0 = s.start_ts;
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 1, iou: 0.95, dyaw: 1.0 }, t0 + 10000);
  const fin = SM.finishSession(s, { cvatSaved: true }, t0 + 10000);

  assert.equal(fin.job_id, '18126');
  assert.equal(fin.task_name, '');                     // the task name is never kept (it can carry dataset / scene names)
  assert.equal(fin.saved_boxes, 1);
  assert.equal(typeof fin.duration_seconds, 'number');
  assert.equal(fin.speedup_factor, null);                    // no manual measurement: no baseline, no invented speed-up
  assert.equal(fin.avg_seconds_per_box_manual, null);
  assert.equal(typeof fin.tool_breakdown, 'object');
  assert.equal(typeof fin.class_stats, 'object');
  assert.ok(fin.class_stats.car != null);
});

test('addManual: làm tay trong CVAT vào số liệu làm tay, không vào saved_boxes, và thành baseline của speedup', () => {
  const s = SM.createSession({ jobId: 7, origin: 'x' });
  SM.addManual(s, 120, 4);
  SM.addManual(s, 0, 0);
  assert.equal(s.manual_count, 4);
  assert.equal(s.manual_time_seconds, 120);
  assert.equal(s.native_manual_count, 4);
  assert.equal(s.saved_boxes, 0);
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 1, edited: false, iou: 1 }, s.start_ts + 10000);
  const fin = SM.finishSession(s);
  assert.equal(fin.avg_seconds_per_box_manual, 30);
});

test('addPanel: thời gian mở panel cộng dồn vào phiên, không đụng số liệu làm tay/tool', () => {
  const s = SM.createSession({ jobId: 7, origin: 'x' });
  SM.addPanel(s, 30); SM.addPanel(s, 0); SM.addPanel(s, 12.5);
  assert.equal(s.panel_seconds, 42.5);
  assert.equal(s.tool_time_seconds, 0);
  assert.equal(s.manual_time_seconds, 0);
});

if (fail > 0) {
  console.error(`${fail} FAILED`);
  process.exit(1);
} else {
  console.log('session: all passed');
}

test('không có số đo làm tay thì không có tăng tốc; IoU được xếp nhóm thật; không dùng mốc 45 s', () => {
  const s = SM.createSession({ jobId: 9, origin: 'x' });
  const t0 = s.start_ts;
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 1, edited: false, iou: 0.95, dyaw: 1 }, t0 + 10000);
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 2, edited: true, iou: 0.8, dyaw: 3 }, t0 + 20000);
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 3, edited: true, iou: 0.4, dyaw: 9 }, t0 + 30000);
  const fin = SM.finishSession(s, {}, t0 + 30000);
  assert.deepEqual(fin.iou_hist, { high: 1, mid: 1, low: 1 });
  assert.equal(fin.speedup_factor, null);
  assert.equal(fin.time_saved_seconds, 0);
  const agg = SM.aggregateSessions([fin]);
  assert.equal(agg.overall_speedup, null);
  assert.equal(agg.has_manual_baseline, false);
  assert.deepEqual(agg.iou_histogram, { high: 1, mid: 1, low: 1 });
  assert.equal(agg.speed_trend[0].manual_speed, null);
  // an older session saved with the fixed 45 s baseline: the stored speed-up is ignored, the raw counters decide
  const old = { ...fin, speedup_factor: 3, avg_seconds_per_box_manual: 45, manual_count: 0, manual_time_seconds: 0 };
  assert.equal(SM.aggregateSessions([old]).overall_speedup, null);
  assert.equal(SM.metricsOf(old).speedup, null);
});

test('phiên mới có trạng thái, tham số tính giờ và không giữ tên task', () => {
  const s = SM.createSession({ jobId: 3, taskName: 'scene-0061', params: { edit_iou: 0.9 } });
  assert.equal(s.status, 'active');
  assert.equal(s.ended_reason, null);
  assert.equal(s.resumed_count, 0);
  assert.equal(s.task_name, '');
  assert.deepEqual(s.frame_times, {});
  assert.equal(s.params.idle_sec, 120);
  assert.equal(s.params.action_cap_sec, 25);
  assert.equal(s.params.edit_iou, 0.9);
  assert.equal(JSON.stringify(s).includes('scene-0061'), false);
});

test('frame_times: giây tool / tay / panel và số box theo từng frame', () => {
  const s = SM.createSession({ jobId: 3 });
  const t0 = s.start_ts;
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 7, edited: false, iou: 0.95 }, t0 + 10000);
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 7, edited: false, iou: 0.95 }, t0 + 16000);
  SM.recordAction(s, { action: 'skip', how: 'T', label: 'car', frame: 8 }, t0 + 20000);
  SM.addManual(s, 30, 2, 8);
  SM.addPanel(s, 12.5, 8);
  SM.addManual(s, 5, 0);                                   // no frame: still counted in the session, no row
  assert.deepEqual(s.frame_times['7'], { tool_s: 16, manual_s: 0, panel_s: 0, boxes: 2 });
  assert.deepEqual(s.frame_times['8'], { tool_s: 4, manual_s: 30, panel_s: 12.5, boxes: 0 });
  assert.equal(s.manual_time_seconds, 35);
  assert.equal(Object.keys(s.frame_times).length, 2);
});

test('tạm dừng rồi tiếp tục: thời gian tạm dừng không tính vào thời gian làm việc', () => {
  const s = SM.createSession({ jobId: 3 });
  const t0 = s.start_ts;
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 1, edited: false, iou: 0.95 }, t0 + 10000);
  SM.pauseSession(s, t0 + 20000);
  SM.resumeFromPrevious(s, t0 + 20000 + 3600 * 1000);      // an hour later
  assert.equal(s.status, 'active');
  assert.equal(s.resumed_count, 1);
  assert.equal(s.total_paused_seconds, 3600);
  const fin = SM.finishSession(s, { reason: 'exit' }, t0 + 20000 + 3600 * 1000 + 40000);
  assert.equal(fin.duration_seconds, 60);                  // 20 s before the pause + 40 s after
  assert.equal(fin.status, 'completed');
  assert.equal(fin.ended_reason, 'exit');
});

test('phiên bỏ dở (stale): coi như tạm dừng lúc hoạt động cuối, thời gian vắng không tính', () => {
  const s = SM.createSession({ jobId: 3 });
  const t0 = s.start_ts;
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 1, edited: false, iou: 0.95 }, t0 + 30000);
  assert.equal(SM.settleStale(s, t0 + 30000 + 5 * 60 * 1000), false);       // 5 min: still the same sitting
  assert.equal(s.status, 'active');
  assert.equal(SM.settleStale(s, t0 + 30000 + 3 * 3600 * 1000), true);      // 3 h later: left open
  assert.equal(s.status, 'paused');
  assert.equal(s.paused_at, t0 + 30000);
  assert.equal(s.stale, true);
  const snap = SM.snapshot(s, t0 + 30000 + 3 * 3600 * 1000);
  assert.equal(snap.duration_seconds, 30);                                  // the 3 h are not work
  assert.equal(snap.status, 'paused');
  assert.equal(snap.ended_at, null);
  assert.equal(s.status, 'paused');                                         // the session itself is not changed by a snapshot
  const fin = SM.finishSession(s, {}, t0 + 30000 + 3 * 3600 * 1000);
  assert.equal(fin.ended_reason, 'stale');
  assert.equal(fin.duration_seconds, 30);
  assert.equal(fin.stale, undefined);
});

test('hoạt động của compare (addManual / addPanel) giữ phiên khỏi bị coi là bỏ dở', () => {
  const s = SM.createSession({ jobId: 3 });
  const t0 = s.start_ts;
  SM.addManual(s, 20, 1, 5, t0 + 9 * 60 * 1000);
  assert.equal(SM.settleStale(s, t0 + 12 * 60 * 1000), false);              // 3 min after the last manual work
});

test('tiếp tục phiên cũ: resumed_count tăng, bỏ cờ stale; phiên rỗng không có hoạt động', () => {
  const s = SM.createSession({ jobId: 3 });
  const t0 = s.start_ts;
  assert.equal(s.saved_boxes === 0 && s.total_actions === 0, true);         // an empty session: the window shows no summary for it
  SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 1, edited: false, iou: 1 }, t0 + 5000);
  SM.settleStale(s, t0 + 5000 + 2 * 3600 * 1000);
  SM.resumeFromPrevious(s, t0 + 5000 + 2 * 3600 * 1000 + 1000);
  SM.pauseSession(s, t0 + 5000 + 2 * 3600 * 1000 + 61000);
  SM.resumeFromPrevious(s, t0 + 5000 + 3 * 3600 * 1000);
  assert.equal(s.resumed_count, 2);
  assert.equal(s.stale, undefined);
  assert.equal(s.status, 'active');
});
