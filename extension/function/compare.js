/*
 * Làm tay trực tiếp trong CVAT (PLAN: bảng so sánh Làm tay vs Dùng tool). The clock runs by itself while the annotator
 * works on the 3D data in CVAT (pointer / wheel / key activity) and stops GRACE seconds after the last action; the objects
 * CVAT gains in that time (shapes + tracks of the job) are the manual objects. What is measured waits as `pending` until a
 * session exists, then goes into its manual figures. Pure: the caller passes the time and the job's object total.
 */
(function (root) {
  'use strict';
  const GRACE_SEC = 5;                      // no action for this long: the annotator is not working on the data
  const PANEL_GRACE_SEC = 60;               // labelling 2D in the extension: looking at the images between clicks is work too
  const IDLE_SEC = 120;                     // a gap longer than this between ticks (tab asleep, machine off) is not counted

  const create = () => ({ sec: 0, count: 0, lastTs: 0, lastCount: null, activeUntil: 0 });

  /** An action on the 3D data at `now` (ms). */
  function activity(s, now, grace = GRACE_SEC) { s.activeUntil = now + grace * 1000; return s; }

  /** Move the clock to `now`. total: objects in the job now (null: unknown). counting: false while the tool itself is
   *  saving boxes, so those do not count as manual; `working` false: no time at all (panel open: the tool's own clock runs). */
  function tick(s, now, total = null, { working = true, counting = true } = {}) {
    const gap = (now - s.lastTs) / 1000;
    if (working && s.lastTs && gap > 0 && gap <= IDLE_SEC) {
      const upto = Math.min(now, s.activeUntil);
      if (upto > s.lastTs) s.sec += (upto - s.lastTs) / 1000;
    }
    if (total != null) {
      if (counting && s.lastCount != null && total > s.lastCount) s.count += total - s.lastCount;
      s.lastCount = total;
    }
    s.lastTs = now;
    return s;
  }
  /** What is measured and not yet in a session; the clock restarts from zero. */
  function drain(s) {
    const out = { sec: s.sec, count: s.count };
    s.sec = 0; s.count = 0;
    return out;
  }

  /** Seconds per object of each side, how many times faster the tool is, and the time it saved against doing its objects by hand. */
  function summary(manual, tool) {
    const tay = manual.count ? manual.sec / manual.count : null, tl = tool.count ? tool.sec / tool.count : null;
    return { tay, tool: tl, speedup: tay && tl ? tay / tl : null, savedSec: tay != null ? tay * tool.count - tool.sec : null };
  }
  const mmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const f1 = (v) => (v == null ? '—' : v.toFixed(1));
  /** Markdown table to paste in the report. */
  function toText(manual, tool, label = '') {
    const r = summary(manual, tool);
    return [`${label ? `**${label}**\n\n` : ''}| Cách làm | Object | Thời gian | Giây/object |`, '|---|---|---|---|',
      `| Làm tay | ${manual.count} | ${mmss(manual.sec)} | ${f1(r.tay)} |`,
      `| 2D track + tool | ${tool.count} | ${mmss(tool.sec)} | ${f1(r.tool)} |`,
      '', r.speedup ? `Tool nhanh hơn ${r.speedup.toFixed(1)}×, tiết kiệm ${mmss(Math.max(0, r.savedSec))} cho ${tool.count} object.` : 'Chưa đủ số liệu của cả hai cách để so sánh.'].join('\n');
  }

  const HOW = { T: 'auto (T)', lan: 'tracker (lan)', tracker: 'tracker (lan)', learned: 'learned', tay: 'bán tự động (N)' };
  const cell = (v) => String(v ?? '').replace(/\|/g, '/');
  /** The report an annotator sends: both clocks of the job, what the tool did, and the box-by-box log of the session.
   *  manual / tool: {sec, count}; session: the open session (or null); records: its edit-log lines. */
  function toReport({ task = '', jobId = '', deviceId = '', sessionId = '', exportedAt = new Date().toISOString(), manual, tool, session = null, records = [] }) {
    const r = summary(manual, tool), a = session || {}, tb = a.tool_breakdown || {};
    const rate = a.tool_count ? `${(100 * (a.edited_count || 0) / a.tool_count).toFixed(1)}% (${a.edited_count || 0}/${a.tool_count})` : '—';
    const iou = a.iou_count ? (a.iou_sum / a.iou_count).toFixed(3) : '—', yaw = a.yaw_err_count ? `${(a.yaw_err_sum / a.yaw_err_count).toFixed(1)}°` : '—';
    const out = [
      `# Báo cáo thời gian gán nhãn · ${cell(task) || 'task'} · job ${jobId}`, '',
      `- **Device ID**: \`${deviceId || '—'}\``, `- **Phiên**: ${sessionId ? `\`${sessionId}\`` : 'chưa mở extension'}`,
      `- **Xuất lúc**: ${exportedAt.replace('T', ' ').slice(0, 19)}`, '',
      '## Tổng quan', '',
      '| Cách làm | Object | Thời gian | Giây/object |', '|---|---|---|---|',
      `| Làm tay trong CVAT | ${manual.count} | ${mmss(manual.sec)} | ${f1(r.tay)} |`,
      `| Tool (extension, label 2D) | ${tool.count} | ${mmss(tool.sec)} | ${f1(r.tool)} |`, '',
      r.speedup ? `Tool nhanh hơn ${r.speedup.toFixed(1)}×, tiết kiệm ${mmss(Math.max(0, r.savedSec))} cho ${tool.count} object.` : 'Chỉ có số liệu của một cách làm trong file này.', '',
      '## Chi tiết Tool', '',
      `- Thời gian mở panel (đang thao tác): ${mmss(a.panel_seconds || 0)}`,
      `- Box lưu: ${a.saved_boxes || 0} (bán tự động N: ${tb.semi_auto || 0}, auto T: ${tb.auto_3d || 0}, tracker: ${tb.tracker_3d || 0}, khác: ${(tb.learned || 0) + (tb.click_fit || 0)})`,
      `- Tỉ lệ phải chỉnh lại so với đề xuất của máy: ${rate}`, `- IoU 3D trung bình so với đề xuất của máy: ${iou}`, `- Sai lệch yaw trung bình: ${yaw}`, '',
      '## Log từng box', ''];
    const saves = records.filter((x) => x.action === 'save');
    if (saves.length) {
      out.push('| # | Frame | Nhãn | Cách tạo | Giây dành cho box | Đã sửa |', '|---|---|---|---|---|---|');
      saves.forEach((x, i) => out.push(`| ${i + 1} | ${cell(x.frame)} | ${cell(x.label)} | ${HOW[x.how] || cell(x.how)} | ${x.time_spent_seconds != null ? (+x.time_spent_seconds).toFixed(1) : '—'} | ${x.edited == null ? '—' : x.edited ? 'có' : 'không'} |`));
    } else out.push('_Chưa có box nào lưu qua extension._');
    out.push('', '> Làm tay trong CVAT chỉ có tổng thời gian và số object (extension không thấy từng box vẽ trực tiếp trong CVAT).', '');
    return out.join('\n');
  }

  const api = { create, activity, tick, drain, summary, toText, toReport, mmss, GRACE_SEC, PANEL_GRACE_SEC, IDLE_SEC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CompareTimer = api;
})(typeof self !== 'undefined' ? self : this);
