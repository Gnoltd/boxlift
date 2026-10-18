/*
 * Runs in the CVAT page itself (MAIN world). Registers as an official CVAT UI plugin
 * (window.cvatUI.registerComponent, cvat-ui plugins-entrypoint.tsx) and hands the content script the
 * frames CVAT has already downloaded for the open job, so the extension never fetches a point cloud
 * or camera image a second time:
 *   cloud  -> job.frames.get(n).data().imageData   (Blob: the .pcd / .bin file of a 3D job)
 *   images -> job.frames.contextImage(n)            ({image_0: ImageBitmap, ...}, cloned, not moved)
 * Answers only same-window messages and only for the job open in this page; it exposes nothing the
 * page does not already have.
 */
(function () {
  'use strict';
  const REQ = 'lidar-cam-req', RES = 'lidar-cam-res';
  let store = null;
  const reply = (msg, transfer = []) => window.postMessage({ [RES]: msg }, location.origin, transfer);

  function register() {
    if (store || !window.cvatUI) return;
    window.cvatUI.registerComponent(({ store: s }) => {
      store = s;
      return { name: 'lidar-cam-bridge', destructor() { store = null; } };
    });
    reply({ ready: true });
  }
  if (window.cvatUI) register();
  else document.addEventListener('plugins.ready', register, { once: true });

  function jobOf(id) {
    const j = store && store.getState().annotation?.job?.instance;
    return j && j.id === id ? j : null;
  }
  const ops = {
    async cloud(job, frame) {
      const f = await job.frames.get(frame);
      const { imageData } = await f.data();
      if (!(imageData instanceof Blob)) return [null];
      const buf = await imageData.arrayBuffer();               // a copy: safe to transfer
      return [{ buf, name: f.filename }, [buf]];
    },
    /** Objects of the job right now, unsaved ones included (statistics are computed from CVAT's own state). */
    async count(job) {
      const t = (await job.annotations.statistics()).total || {};
      let n = 0;
      for (const v of Object.values(t)) if (v && typeof v === 'object') n += (v.shape || 0) + (v.track || 0);
      return [n];
    },
    async images(job, frame) {
      return [Object.entries(await job.frames.contextImage(frame))];   // CVAT keeps showing its own bitmaps
    },
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object' || !e.data[REQ]) return;
    const { op, id, jobId, frame } = e.data[REQ];
    if (op === 'ping') { if (store) reply({ ready: true }); return; }
    if (!ops[op]) return;
    try {
      const job = jobOf(jobId);
      const [result, transfer] = job ? await ops[op](job, frame) : [null];
      reply({ id, result }, transfer);
    } catch (err) {
      reply({ id, error: String((err && err.message) || err) });
    }
  });
})();
