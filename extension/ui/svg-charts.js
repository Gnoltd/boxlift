/*
 * svg-charts.js — Bộ helper vẽ biểu đồ SVG thuần cho Analytics Dashboard
 *
 * Tiêu chí:
 *  - Zero dependency: Không dùng Chart.js hay D3.
 *  - Tuyệt đối an toàn: Tuân thủ Manifest V3 CSP (không eval, không new Function).
 *  - Tương thích Retina & Responsive: Tự scale theo viewBox của SVG.
 */
(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Colours are CSS custom properties of the BoxLift window (var(--ok) ...), so fill / stroke / font-family go through style:
  // a presentation attribute does not take var() everywhere, a style declaration always does.
  const COLOR_ATTRS = new Set(['fill', 'stroke', 'font-family']);
  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (COLOR_ATTRS.has(k)) el.style.setProperty(k, v); else el.setAttribute(k, v);
    }
    return el;
  }

  /**
   * Biểu đồ đường xu hướng tốc độ gán nhãn (Speed Trend: Manual vs Tool qua các phiên)
   * data: [{ label, manual, tool, boxes }]
   */
  function lineChart(data = [], opts = {}) {
    const W = opts.width || 560;
    const H = opts.height || 180;
    const padL = 45, padR = 25, padT = 25, padB = 35;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%', style: 'overflow:visible' });

    if (!data.length) {
      const txt = svgEl('text', { x: W / 2, y: H / 2, fill: 'var(--muted)', 'text-anchor': 'middle', 'font-size': '12' });
      txt.textContent = opts.emptyText || '';
      svg.appendChild(txt);
      return svg;
    }

    // Xác định max Y (giây / box)
    let maxY = 50;
    data.forEach((d) => {
      maxY = Math.max(maxY, d.manual || 0, d.tool || 0);
    });
    maxY = Math.ceil(maxY / 10) * 10;

    // Lưới ngang (grid lines)
    const gridCount = 4;
    for (let i = 0; i <= gridCount; i++) {
      const yVal = (maxY / gridCount) * i;
      const y = padT + innerH - (innerH * (yVal / maxY));
      const line = svgEl('line', {
        x1: padL, y1: y, x2: padL + innerW, y2: y,
        stroke: 'var(--line)', 'stroke-width': '1', 'stroke-dasharray': i === 0 ? '0' : '3,3'
      });
      svg.appendChild(line);

      const label = svgEl('text', {
        x: padL - 8, y: y + 4, fill: 'var(--muted)', 'text-anchor': 'end', 'font-size': '10', 'font-family': 'var(--mono)'
      });
      label.textContent = `${Math.round(yVal)}s`;
      svg.appendChild(label);
    }

    const n = data.length;
    const getX = (i) => padL + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
    const getY = (val) => padT + innerH - (innerH * ((val || 0) / maxY));

    // Đường Manual: --warn, nét đứt (khác Tool cả về nét, không chỉ màu)
    // manual == null: not measured in that session, so no point and no line through it (never a made-up value)
    const hasManual = (d) => Number.isFinite(d.manual);
    const ptsManual = data.map((d, i) => (hasManual(d) ? `${getX(i).toFixed(1)},${getY(d.manual).toFixed(1)}` : null)).filter(Boolean).join(' ');
    if (ptsManual) svg.appendChild(svgEl('polyline', {
      points: ptsManual, fill: 'none', stroke: 'var(--warn)', 'stroke-width': '2', 'stroke-dasharray': '5,4'
    }));

    // Đường Tool: --accent, nét liền dày
    const ptsTool = data.map((d, i) => `${getX(i).toFixed(1)},${getY(d.tool).toFixed(1)}`).join(' ');
    const pathTool = svgEl('polyline', {
      points: ptsTool, fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2.5'
    });
    svg.appendChild(pathTool);

    // Vẽ các điểm mút và nhãn X
    data.forEach((d, i) => {
      const x = getX(i);
      const ym = getY(d.manual);
      const yt = getY(d.tool);

      // Điểm manual
      if (hasManual(d)) svg.appendChild(svgEl('circle', { cx: x, cy: ym, r: '3.5', fill: 'var(--warn)' }));

      // Điểm tool
      const ct = svgEl('circle', { cx: x, cy: yt, r: '4', fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': '1.5' });
      svg.appendChild(ct);

      // Tool speed tag
      const tag = svgEl('text', {
        x, y: yt - 8, fill: 'var(--accent)', 'text-anchor': 'middle', 'font-size': '10', 'font-weight': '600', 'font-family': 'var(--mono)'
      });
      tag.textContent = `${d.tool}s`;
      svg.appendChild(tag);

      // Nhãn trục X
      const xLbl = svgEl('text', {
        x, y: H - 8, fill: 'var(--muted)', 'text-anchor': 'middle', 'font-size': '10'
      });
      xLbl.textContent = d.label || `#${i + 1}`;
      svg.appendChild(xLbl);
    });

    return svg;
  }

  /**
   * Biểu đồ thanh ngang hoặc thanh xếp chồng (Bar/Progress)
   * items: [{ label, value, max, color, sub }]
   */
  function horizontalBars(items = []) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:8px; width:100%;';

    items.forEach((it) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid; grid-template-columns: 150px 1fr 48px; align-items:center; gap:10px; font-size:12px;';

      const lbl = document.createElement('span');
      lbl.textContent = it.label;
      lbl.style.cssText = 'color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'; lbl.title = it.label;

      const barBg = document.createElement('div');
      barBg.style.cssText = 'height:8px; background:var(--line); border-radius:4px; overflow:hidden; position:relative;';

      const barFill = document.createElement('div');
      const pct = Math.min(100, Math.max(0, it.max > 0 ? (it.value / it.max) * 100 : it.value));
      barFill.style.cssText = `height:100%; width:${pct}%; background:${it.color || 'var(--ok)'}; border-radius:4px; transition:width .3s ease;`;
      barBg.appendChild(barFill);

      const val = document.createElement('span');
      val.style.cssText = 'font-family:var(--mono); color:var(--muted); text-align:right; font-size:11px;';
      val.textContent = it.sub != null ? it.sub : `${it.value}`;

      row.append(lbl, barBg, val);
      wrap.appendChild(row);
    });

    return wrap;
  }

  /**
   * Biểu đồ Donut phân bổ phương pháp (Tracker vs Auto vs Manual)
   * slices: [{ label, count, color }]
   */
  function donutChart(slices = [], size = 130) {
    const total = slices.reduce((acc, s) => acc + (s.count || 0), 0);
    const svg = svgEl('svg', { viewBox: '0 0 100 100', width: `${size}px`, height: `${size}px` });

    const cx = 50, cy = 50, r = 38, strokeWidth = 14;
    const circ = 2 * Math.PI * r;

    if (!total) {
      const empty = svgEl('circle', {
        cx, cy, r, fill: 'none', stroke: 'var(--line)', 'stroke-width': strokeWidth
      });
      svg.appendChild(empty);
      return svg;
    }

    let offset = 0;
    slices.forEach((s) => {
      const pct = (s.count || 0) / total;
      const dash = pct * circ;
      const c = svgEl('circle', {
        cx, cy, r, fill: 'none', stroke: s.color, 'stroke-width': strokeWidth,
        'stroke-dasharray': `${dash} ${circ - dash}`,
        'stroke-dashoffset': -offset,
        transform: `rotate(-90 ${cx} ${cy})`
      });
      svg.appendChild(c);
      offset += dash;
    });

    // Center text
    const txt = svgEl('text', {
      x: cx, y: cy + 4, fill: 'var(--text)', 'text-anchor': 'middle', 'font-size': '13', 'font-weight': '650', 'font-family': 'var(--mono)'
    });
    txt.textContent = total;
    svg.appendChild(txt);

    return svg;
  }

  const api = { lineChart, horizontalBars, donutChart };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SvgCharts = api;
})(typeof self !== 'undefined' ? self : this);
