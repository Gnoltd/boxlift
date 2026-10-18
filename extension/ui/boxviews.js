/*
 * Three box-aligned views of a cuboid and its LiDAR points (top / side / front), as in CVAT's 3D
 * editor, shown as three separate panes under the camera image:
 *   - drag an edge   -> that face moves, the opposite face stays (length / width / height / bottom)
 *   - drag inside    -> move the box in that view's plane
 *   - drag outside   -> rotate: top = heading, side = pitch (nose up/down), front = roll
 * Box frame: a = along the length (front +), b = along the width (left +), z up (the box's heading frame;
 * a tilted box is drawn with its real faces).
 * Usage: BoxViews.create(container, { box, cloud, onLive, onCommit, onRotate }) -> { draw() }
 *   box(): the box being edited (mutated in place) or null; cloud(): {xyz, ground} of the frame;
 *   onLive(): during a drag; onCommit(): after a change; onRotate(yaw): after a heading change.
 */
(function (root) {
  'use strict';
  const BF = root.BoxFit || (typeof require !== 'undefined' ? require('../function/boxfit.js') : null);
  const MAR = 0.8;                      // metres shown around the box
  // each view: screen-right axis H and screen-up axis V as (box axis, sign); 'z' is height
  const VIEWS = [
    { id: 'top', title: 'Trên · kéo ngoài box = xoay hướng', H: ['b', -1], V: ['a', 1], face: null },
    { id: 'side', title: 'Hông · kéo ngoài box = dốc (pitch)', H: ['a', 1], V: ['z', 1], face: ['b', -1] },
    { id: 'front', title: 'Trước · kéo ngoài box = nghiêng (roll)', H: ['b', 1], V: ['z', 1], face: ['a', 1] },
  ];
  const SIZE = { a: 'l', b: 'w', z: 'h' };

  function create(container, cb) {
    const dpr = () => window.devicePixelRatio || 1;
    const els = VIEWS.map((v) => {
      const wrap = document.createElement('div'); wrap.className = 'bv';
      const cap = document.createElement('div'); cap.className = 'bvt'; cap.textContent = v.title;
      const cv = document.createElement('canvas');
      wrap.append(cap, cv); container.append(wrap);
      return { v, cv, w: 260, h: 180 };
    });
    let drag = null;                    // {el, kind, frame, k, box0, ...}
    let near = null;                    // candidate point indices around the box (cached)

    const local = (F, x, y, z) => {     // world -> heading frame F
      const dx = x - F.x, dy = y - F.y, c = Math.cos(F.yaw), s = Math.sin(F.yaw);
      return { a: dx * c + dy * s, b: -dx * s + dy * c, z: z - F.z };
    };
    const comp = (p, ax) => p[ax[0]] * ax[1];
    function scaleFor(e, b) {
      const ext = (ax) => b[SIZE[ax[0]]] / 2 + MAR;
      return Math.min(e.w / (2 * ext(e.v.H)), e.h / (2 * ext(e.v.V)));
    }
    function candidates(xyz, b) {
      const R = Math.hypot(b.l, b.w) / 2 + MAR + 1.5;
      if (near && near.xyz === xyz && Math.hypot(near.x - b.x, near.y - b.y) < 1 && near.R >= R) return near.idx;
      const idx = [], R2 = (R + 1) * (R + 1);
      for (let i = 0, n = xyz.length / 3; i < n; i++) {
        const dx = xyz[3 * i] - b.x, dy = xyz[3 * i + 1] - b.y;
        if (dx * dx + dy * dy < R2) idx.push(i);
      }
      near = { xyz, x: b.x, y: b.y, R: R + 1, idx };
      return idx;
    }

    function draw() {
      const b = cb.box(), cl = cb.cloud(), r = dpr();
      for (const e of els) {                                    // panes follow the container's size
        if (drag) continue;
        e.w = Math.max(80, e.cv.parentElement.clientWidth); e.h = Math.max(60, e.cv.parentElement.clientHeight - 22);
      }
      for (const e of els) {
        const { v, cv } = e;
        cv.style.width = e.w + 'px'; cv.style.height = e.h + 'px'; cv.width = e.w * r; cv.height = e.h * r;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#0b0d11'; ctx.fillRect(0, 0, cv.width, cv.height);
        if (!b || !cl) {
          ctx.fillStyle = '#8b93a7'; ctx.font = `${12 * r}px system-ui, sans-serif`; ctx.textAlign = 'center';
          ctx.fillText('Vẽ hoặc chọn một box', cv.width / 2, cv.height / 2); ctx.textAlign = 'start';
          continue;
        }
        const idx = candidates(cl.xyz, b), xyz = cl.xyz;
        const F = drag ? drag.frame : b, k = (drag ? drag.k[v.id] : scaleFor(e, b)) * r;
        const X = (h) => cv.width / 2 + h * k, Y = (vv) => cv.height / 2 - vv * k;
        // points: within the box's extent along this view's depth axis (+ margin)
        const depth = ['a', 'b', 'z'].find((ax) => ax !== v.H[0] && ax !== v.V[0]);
        const half = { a: b.l / 2, b: b.w / 2, z: b.h / 2 }, bl = local(F, b.x, b.y, b.z), R = BF.rotMat(b);
        const gz = [];
        for (const i of idx) {
          if (cl.ground && cl.ground[i]) { gz.push(xyz[3 * i + 2]); continue; }
          const p = local(F, xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
          if (Math.abs(p[depth] - bl[depth]) > half[depth] + 0.5) continue;
          const u = X(comp(p, v.H)), w = Y(comp(p, v.V));
          if (u < 0 || w < 0 || u > cv.width || w > cv.height) continue;
          const dx = xyz[3 * i] - b.x, dy = xyz[3 * i + 1] - b.y, dz = xyz[3 * i + 2] - b.z;
          const inside = Math.abs(R[0][0] * dx + R[1][0] * dy + R[2][0] * dz) <= half.a + 0.05 && Math.abs(R[0][1] * dx + R[1][1] * dy + R[2][1] * dz) <= half.b + 0.05 &&
            Math.abs(R[0][2] * dx + R[1][2] * dy + R[2][2] * dz) <= half.z + 0.05;
          ctx.fillStyle = inside ? '#ff3df2' : 'rgba(170,180,200,.6)';
          ctx.fillRect(u - r, w - r, 2 * r, 2 * r);
        }
        if (v.V[0] === 'z' && gz.length) {                     // ground level under the box
          gz.sort((p, q) => p - q);
          ctx.strokeStyle = 'rgba(57,197,255,.7)'; ctx.setLineDash([4 * r, 4 * r]); ctx.lineWidth = r;
          const y = Y(gz[gz.length >> 1] - F.z); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke(); ctx.setLineDash([]);
        }
        // the box: its real faces (works for tilted boxes)
        const corner = (sa, sb, sz) => { const p = BF.toWorld(b, sa * b.l / 2, sb * b.w / 2, sz * b.h / 2), q = local(F, ...p); return [X(comp(q, v.H)), Y(comp(q, v.V))]; };
        const poly = v.id === 'top' ? [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].map((c) => corner(...c))
          : v.id === 'side' ? [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]].map((c) => corner(...c))
            : [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]].map((c) => corner(...c));
        ctx.strokeStyle = '#3dff6e'; ctx.lineWidth = 2 * r; ctx.beginPath();
        poly.forEach(([u, w], i) => (i ? ctx.lineTo(u, w) : ctx.moveTo(u, w))); ctx.closePath(); ctx.stroke();
        ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 3 * r; ctx.beginPath();     // front in yellow
        if (v.id === 'top') { ctx.moveTo(...poly[1]); ctx.lineTo(...poly[2]); }
        else if (v.id === 'side') { ctx.moveTo(...poly[1]); ctx.lineTo(...poly[2]); }
        else { poly.forEach(([u, w], i) => (i ? ctx.lineTo(u, w) : ctx.moveTo(u, w))); ctx.closePath(); }
        ctx.stroke();
        const pr = BF.pitchRollOf(b), deg = (x) => (x * 180 / Math.PI).toFixed(1);
        ctx.font = `${11 * r}px ui-monospace, Menlo, monospace`; ctx.fillStyle = '#e6e8ee'; ctx.textBaseline = 'top';
        const dims = { top: `dài ${b.l.toFixed(2)} · rộng ${b.w.toFixed(2)} · hướng ${deg(b.yaw)}°`, side: `dài ${b.l.toFixed(2)} · cao ${b.h.toFixed(2)} · dốc ${deg(pr.pitch)}°`, front: `rộng ${b.w.toFixed(2)} · cao ${b.h.toFixed(2)} · nghiêng ${deg(pr.roll)}°` }[v.id];
        ctx.fillText(dims, 6 * r, cv.height - 16 * r); ctx.textBaseline = 'alphabetic';
      }
    }

    // ---- interaction
    function hit(e, ev, b) {
      const { v, cv } = e, rect = cv.getBoundingClientRect(), k = scaleFor(e, b);
      const h = (ev.clientX - rect.left - e.w / 2) / k, vv = -(ev.clientY - rect.top - e.h / 2) / k;
      const hh = b[SIZE[v.H[0]]] / 2, hv = b[SIZE[v.V[0]]] / 2, tol = 8 / k;
      const inH = Math.abs(h) <= hh + tol, inV = Math.abs(vv) <= hv + tol;
      if (inV && Math.abs(Math.abs(h) - hh) < tol) return { kind: 'edge', axis: v.H, side: Math.sign(h) || 1 };
      if (inH && Math.abs(Math.abs(vv) - hv) < tol) return { kind: 'edge', axis: v.V, side: Math.sign(vv) || 1 };
      if (Math.abs(h) < hh && Math.abs(vv) < hv) return { kind: 'move' };
      return { kind: 'rotate' };
    }
    els.forEach((e) => {
      const { v, cv } = e;
      const pos = (ev) => { const rect = cv.getBoundingClientRect(); return [ev.clientX - rect.left - e.w / 2, -(ev.clientY - rect.top - e.h / 2)]; };
      cv.addEventListener('pointermove', (ev) => {
        const b = cb.box(); if (!b) return;
        ev.stopPropagation();
        if (!drag) {
          const t = hit(e, ev, b);
          cv.style.cursor = t.kind === 'move' ? 'move' : t.kind === 'rotate' ? 'grab' : t.axis === v.H ? 'ew-resize' : 'ns-resize';
          return;
        }
        if (drag.el !== e) return;
        const [ph, pv] = pos(ev), k = drag.k[v.id], b0 = drag.box0;
        if (drag.kind === 'rotate') {
          const d = Math.atan2(pv, ph) - drag.ang0;
          if (v.id === 'top') BF.setYaw(b, b0.yaw + d, drag.pr);
          else if (v.id === 'side') Object.assign(b, BF.tiltFromPitchRoll(b0.yaw, drag.pr.pitch + d, drag.pr.roll));
          else Object.assign(b, BF.tiltFromPitchRoll(b0.yaw, drag.pr.pitch, drag.pr.roll + d));
        } else {
          const loc = { a: 0, b: 0, z: 0 };                        // centre shift in the heading frame
          if (drag.kind === 'move') {
            loc[v.H[0]] += (ph - drag.p0[0]) / k * v.H[1];
            loc[v.V[0]] += (pv - drag.p0[1]) / k * v.V[1];
            Object.assign(b, { l: b0.l, w: b0.w, h: b0.h });
          } else {
            const ax = drag.axis, dim = SIZE[ax[0]], sideLocal = drag.side * ax[1];
            const m = (ax === v.H ? ph : pv) / k * ax[1];          // mouse, in the box frame along that axis
            const opp = -sideLocal * b0[dim] / 2, size = Math.max(0.1, sideLocal * (m - opp));
            b[dim] = size; loc[ax[0]] = opp + sideLocal * size / 2;
          }
          const c = Math.cos(b0.yaw), s = Math.sin(b0.yaw);
          b.x = b0.x + loc.a * c - loc.b * s; b.y = b0.y + loc.a * s + loc.b * c; b.z = b0.z + loc.z;
        }
        draw(); cb.onLive && cb.onLive();
      });
      cv.addEventListener('pointerdown', (ev) => {
        const b = cb.box(); ev.stopPropagation();
        if (!b || ev.button !== 0) return;
        ev.preventDefault();
        const t = hit(e, ev, b);
        try { cv.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
        const p0 = pos(ev);
        drag = { el: e, ...t, p0, ang0: Math.atan2(p0[1], p0[0]), box0: { ...b }, pr: BF.pitchRollOf(b), frame: { x: b.x, y: b.y, z: b.z, yaw: b.yaw },
          k: Object.fromEntries(els.map((q) => [q.v.id, scaleFor(q, b)])) };
      });
      const end = (ev) => {
        if (!drag || drag.el !== e) return;
        ev.stopPropagation();
        const kind = drag.kind, b = cb.box(); drag = null;
        try { cv.releasePointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
        if (kind === 'rotate' && v.id === 'top' && cb.onRotate) cb.onRotate(b.yaw); else if (cb.onCommit) cb.onCommit();
        draw();
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
    });
    return { draw, get dragging() { return !!drag; } };
  }

  const api = { create, VIEWS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoxViews = api;
})(typeof self !== 'undefined' ? self : this);
