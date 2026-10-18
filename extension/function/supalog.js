/*
 * supalog.js — Supabase REST client cho log thao tác
 *
 * Chức năng:
 *  - Đọc cấu hình (URL + anon key) từ chrome.storage.local
 *  - Push record lên Supabase sau mỗi editlog.record()
 *  - Offline queue: ghi local khi mất mạng, gửi lại khi có mạng
 *  - Query log theo device_id + session_id để hiện trong tab Log
 *  - Đánh dấu downloaded = TRUE sau khi tải CSV
 *  - Xoá record theo session hoặc tất cả
 *
 * Không dùng thư viện @supabase/supabase-js — gọi REST API trực tiếp
 * để tránh phải bundle thêm dependency vào extension.
 *
 * Sử dụng (từ editlog.js hoặc cvat.js):
 *   SupaLog.push(record)           // non-blocking
 *   SupaLog.isConfigured()         // → boolean
 *
 * Sử dụng (từ logtab.js):
 *   await SupaLog.getSessions()
 *   await SupaLog.getLogs(sessionId)
 *   await SupaLog.markDownloaded(ids)
 *   await SupaLog.deleteSession(sessionId)
 *   await SupaLog.deleteAll()
 */
(function (root) {
  'use strict';

  const TABLE   = 'edit_logs';
  const QUEUE_KEY  = 'supalog:queue';
  const CONFIG_KEY = 'supalog:config';   // { url, anonKey }
  const DEVICE_KEY = 'supalog:deviceId';
  const AUTH_KEY   = 'supalog:auth';      // { url, anonKey, access_token, refresh_token, expires_at (ms), user_id }
  const STATUS_KEY = 'supalog:status';    // { error, at, dropped }: lần đồng bộ gần nhất lỗi gì, bao nhiêu log đã bị bỏ vì storage đầy
  const SESS_PENDING_KEY = 'supalog:sessionsPending';   // { session_id: row } tổng kết phiên chưa lên được, gửi lại lần sau
  const VERSION    = (typeof chrome !== 'undefined' && chrome.runtime)
    ? (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '') : '';

  // ── Helpers ──────────────────────────────────────────────────────────────

  const SESSIONS_TABLE = 'annotation_sessions';

  /** Lấy hoặc sinh device UUID (lưu vĩnh viễn trong chrome.storage.local). */
  async function getDeviceId() {
    const { [DEVICE_KEY]: stored } = await chrome.storage.local.get(DEVICE_KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [DEVICE_KEY]: id });
    return id;
  }

  /**
   * Lấy cấu hình Supabase.
   * Ưu tiên 1: cấu hình lưu thủ công trong chrome.storage.local (override).
   * Ưu tiên 2: cấu hình đóng gói sẵn trong config/database.json (setup 1 lần cho cả team).
   * Trả về null nếu chưa cấu hình.
   */
  async function getConfig() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const { [CONFIG_KEY]: cfg } = await chrome.storage.local.get(CONFIG_KEY);
        if (cfg && cfg.url && cfg.anonKey) return { ...cfg, source: 'local' };
      }
    } catch {}

    // Fallback: bundled config/database.json. Asked of the background: a content script on the CVAT page
    // cannot fetch an extension file that is not web-accessible (that is why nothing was saved before).
    try {
      let bundled = null;
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const r = await chrome.runtime.sendMessage({ type: 'getDbConfig' });
        if (r && r.ok) bundled = r.data;
      }
      if (!bundled && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        const res = await fetch(chrome.runtime.getURL('config/database.json'));
        if (res.ok) bundled = await res.json();
      }
      if (bundled && bundled.url && bundled.anonKey && !bundled.url.includes('YOUR_SUPABASE_PROJECT_ID')) {
        return { url: bundled.url, anonKey: bundled.anonKey, source: 'bundled' };
      }
    } catch {}

    return null;
  }

  /** Kiểm tra đã cấu hình Supabase chưa (sync-friendly: cache 10 s). */
  let _cfgCache = null, _cfgTs = 0;
  async function cachedConfig() {
    const now = Date.now();
    if (_cfgCache && now - _cfgTs < 10_000) return _cfgCache;
    _cfgCache = await getConfig();
    _cfgTs = now;
    return _cfgCache;
  }

  // ── Danh tính: đăng nhập ẩn danh của Supabase ───────────────────────────────
  // RLS cho phép mỗi người chỉ đọc / ghi dòng có device_id = auth.uid() của JWT. Danh tính do Supabase ký, không phải header tự khai
  // (x-device-id cũ ai cũng giả được). Mỗi máy đăng nhập ẩn danh một lần, token lưu trong chrome.storage.local và tự gia hạn.
  // Cần bật "Allow anonymous sign-ins" (Authentication → Providers) và chạy db/migrations/2026-10-auth.sql.
  const EXPIRY_SLACK_MS = 60_000;
  let _authP = null;

  async function authCall(cfg, path, body) {
    const res = await fetch(`${cfg.url}/auth/v1/${path}`, {
      method: 'POST',
      headers: { 'apikey': cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw Object.assign(new Error(`Supabase Auth ${path} → ${res.status}: ${text}`), { status: res.status });
    const j = JSON.parse(text);
    return {
      url: cfg.url, anonKey: cfg.anonKey,
      access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      user_id: j.user && j.user.id,
    };
  }

  async function loadAuth(cfg) {
    const { [AUTH_KEY]: st } = await chrome.storage.local.get(AUTH_KEY);
    // another project or key: that identity is not valid here
    return st && st.url === cfg.url && st.anonKey === cfg.anonKey && st.access_token ? st : null;
  }

  // The auth server says a refresh token is no good (revoked, already used, unknown): only then is a new identity the answer.
  // A network error, a 5xx or a 429 is not: the same identity is tried again on the next request, so its history is not given up.
  const TOKEN_REJECTED = [400, 401, 403, 404];
  const fresh = (st) => st && st.expires_at - Date.now() > EXPIRY_SLACK_MS;

  async function ensureAuth(cfg) {
    let st = await loadAuth(cfg);
    if (fresh(st)) return st;
    if (st && st.refresh_token) {
      try { st = await authCall(cfg, 'token?grant_type=refresh_token', { refresh_token: st.refresh_token }); }
      catch (e) {
        if (!TOKEN_REJECTED.includes(e.status)) throw e;          // offline or server trouble: keep the identity, retry later
        const other = await loadAuth(cfg);                        // another tab may have refreshed in the meantime
        if (fresh(other)) return other;
        console.warn('[SupaLog] refresh token rejected, signing in again', e.message);
        st = null;
      }
    } else st = null;
    if (!st) st = await authCall(cfg, 'signup', {});            // anonymous sign-in: an empty body
    await chrome.storage.local.set({ [AUTH_KEY]: st });
    return st;
  }

  /** The signed-in identity { access_token, user_id }. One request at a time (and one tab at a time where Web Locks exist). */
  function getAuth(cfg) {
    if (!_authP) {
      const run = () => ensureAuth(cfg);
      const locked = typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('supalog-auth', run) : run();
      _authP = Promise.resolve(locked).finally(() => { _authP = null; });
    }
    return _authP;
  }

  /** The id this project knows the device by (auth.uid()). */
  async function ownerId(cfg) { return (await getAuth(cfg)).user_id; }

  // Columns added by db/migrations/2026-10-session-v2.sql. A project that has not run it yet answers 400 "Could not find the 'x'
  // column": the rows are sent again without the columns it does not know, so logging keeps working until the migration is run.
  const NEW_COLUMNS = ['track_id', 'n_adjust', 'arm', 'status', 'ended_reason', 'resumed_count', 'last_activity_at', 'frame_times', 'params', 'tracks_created'];
  async function postDroppingMissing(send, body) {
    let b = body, res = await send(b);
    for (let i = 0; i < 3 && !res.ok && b; i++) {
      const text = await res.clone().text().catch(() => '');
      const miss = NEW_COLUMNS.filter((c) => new RegExp(`['"]${c}['"]`).test(text));
      if (!miss.length) break;
      const drop = (r) => { const o = { ...r }; for (const c of miss) delete o[c]; return o; };
      b = Array.isArray(b) ? b.map(drop) : drop(b);
      res = await send(b);
    }
    return res;
  }

  /** Gọi Supabase REST API với JWT của thiết bị. method: 'GET'|'POST'|'PATCH'|'DELETE'. Mọi dòng ghi lên đều mang chủ là chính thiết bị này. */
  async function rest(cfg, method, path, body, params, prefer) {
    const url = new URL(`${cfg.url}/rest/v1/${path}`);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const auth = await getAuth(cfg);
    const headers = {
      'apikey': cfg.anonKey,
      'Authorization': `Bearer ${auth.access_token}`,
      'Content-Type': 'application/json',
      'Prefer': prefer || (method === 'POST' ? 'return=minimal' : 'return=representation'),
    };
    // Rows queued while offline or before sign-in carry the local id: the owner is always the signed-in device (RLS checks it too).
    const own = (r) => ('device_id' in r ? { ...r, device_id: auth.user_id } : 'owner_device_id' in r ? { ...r, owner_device_id: auth.user_id } : r);
    const owned = body && method === 'POST' ? (Array.isArray(body) ? body.map(own) : own(body)) : body;
    const send = (b) => fetch(url.toString(), { method, headers, body: b ? JSON.stringify(b) : undefined });
    const res = method === 'POST' ? await postDroppingMissing(send, owned) : await send(owned);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
    }
    const text = await res.text();                              // return=minimal answers 201 with no body: nothing to parse
    return text ? JSON.parse(text) : null;
  }

  // ── Offline queue ─────────────────────────────────────────────────────────

  // Quota chrome.storage.local là 10 MB mà pose, cache task và cấu hình cũng nằm trong đó: queue chỉ được chiếm ~1 MB.
  const QUEUE_MAX_BYTES = 1_000_000;
  // Đọc / ghi queue lần lượt từng lượt: hai push offline cùng lúc không ghi đè nhau, record vào lúc đang flush không bị xoá theo.
  let _qChain = Promise.resolve();
  const queued = (fn) => (_qChain = _qChain.then(fn, fn));

  // Giữ các record mới nhất vừa ~1 MB: đi từ cuối lên, mỗi record serialize đúng một lần, cắt một lần (O(N), không shift trong vòng lặp).
  function capQueue(q) {
    let i = q.length - 1, bytes = 2 + JSON.stringify(q[i]).length;   // record mới nhất luôn được giữ; 2 = dấu [ ]
    while (i > 0) {
      const n = JSON.stringify(q[i - 1]).length + 1;
      if (bytes + n > QUEUE_MAX_BYTES) break;
      bytes += n; i--;
    }
    return i ? q.slice(i) : q;
  }

  // Trạng thái đồng bộ để trang Log báo cho người dùng: lỗi gần nhất (đăng nhập, mạng, server) và số log đã bị bỏ.
  // Chỉ ghi storage khi trạng thái đổi, không ghi mỗi lần push thành công.
  let _hasError = null;
  async function noteSync(error, dropped = 0) {
    if (!error && !dropped && _hasError === false) return;
    const { [STATUS_KEY]: st = {} } = await chrome.storage.local.get(STATUS_KEY);
    _hasError = !!error;
    if (!error && !dropped && !st.error) return;
    await chrome.storage.local.set({ [STATUS_KEY]: {
      error: error ? String(error).slice(0, 300) : null, at: new Date().toISOString(), dropped: (st.dropped || 0) + dropped,
    } }).catch(() => {});
  }

  async function saveQueue(q) {
    try {
      await chrome.storage.local.set({ [QUEUE_KEY]: q });
    } catch (e) {
      // Vẫn vượt quota (storage bị phần khác chiếm): giữ nửa mới nhất thay vì mất cả queue hoặc làm hỏng caller
      console.warn('[SupaLog] queue write failed, dropping oldest half', e.message);
      await chrome.storage.local.set({ [QUEUE_KEY]: q.slice(q.length >> 1) }).catch(() => {});
      return q.length >> 1;
    }
    return 0;
  }

  function enqueue(record, error) {
    return queued(async () => {
      const { [QUEUE_KEY]: q = [] } = await chrome.storage.local.get(QUEUE_KEY);
      q.push(record);
      const kept = capQueue(q);
      await noteSync(error, q.length - kept.length + await saveQueue(kept));
    });
  }

  // Gửi lại log trong queue và tổng kết phiên còn treo (upsert theo session_id, gửi lại bao nhiêu lần cũng không trùng).
  function flushQueue(cfg, deviceId) {
    return queued(async () => {
      const { [QUEUE_KEY]: q = [], [SESS_PENDING_KEY]: pend = {} } = await chrome.storage.local.get([QUEUE_KEY, SESS_PENDING_KEY]);
      try {
        if (q.length) {
          await rest(cfg, 'POST', TABLE, q);
          await chrome.storage.local.set({ [QUEUE_KEY]: [] });
        }
        for (const [sid, row] of Object.entries(pend)) {
          await rest(cfg, 'POST', SESSIONS_TABLE, row, null, 'resolution=merge-duplicates,return=minimal');
          await dropPendingSession(sid);
        }
      } catch (e) {
        // Giữ queue, thử lại lần sau
        console.warn('[SupaLog] flush queue failed', e.message);
      }
    });
  }

  async function dropPendingSession(sid) {
    const { [SESS_PENDING_KEY]: pend = {} } = await chrome.storage.local.get(SESS_PENDING_KEY);
    if (!(sid in pend)) return;
    delete pend[sid];
    await chrome.storage.local.set({ [SESS_PENDING_KEY]: pend });
  }

  // Giữ tối đa 50 phiên chờ gửi (mỗi phiên một dòng tổng kết, bản mới đè bản cũ).
  function keepPendingSession(row, error) {
    return queued(async () => {
      const { [SESS_PENDING_KEY]: pend = {} } = await chrome.storage.local.get(SESS_PENDING_KEY);
      delete pend[row.session_id];
      pend[row.session_id] = row;
      const ids = Object.keys(pend);
      for (const sid of ids.slice(0, Math.max(0, ids.length - 50))) delete pend[sid];
      await chrome.storage.local.set({ [SESS_PENDING_KEY]: pend }).catch(() => {});
      await noteSync(error);
    });
  }

  /** Tình trạng đồng bộ cho trang Log: số log và phiên đang chờ gửi, lỗi gần nhất, số log đã bị bỏ vì storage đầy. */
  async function syncStatus() {
    const { [QUEUE_KEY]: q = [], [SESS_PENDING_KEY]: pend = {}, [STATUS_KEY]: st = {} } =
      await chrome.storage.local.get([QUEUE_KEY, SESS_PENDING_KEY, STATUS_KEY]);
    return { queued: q.length, sessionsPending: Object.keys(pend).length, error: st.error || null, at: st.at || null, dropped: st.dropped || 0 };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Có cấu hình Supabase hợp lệ chưa? */
  async function isConfigured() {
    return !!(await cachedConfig());
  }

  /**
   * Push 1 record lên Supabase (bất đồng bộ, không throw).
   * Gọi từ editlog.js ngay sau khi tạo record.
   * @param {object} record — kết quả của EditLog.record()
   * @param {string} sessionId — UUID phiên hiện tại
   */
  async function push(record, sessionId) {
    let cfg, deviceId;
    try {
      cfg      = await cachedConfig();
      if (!cfg) return;                        // chưa cấu hình → bỏ qua
      deviceId = await getDeviceId();
    } catch { return; }

    const row = {
      device_id:         deviceId,
      session_id:        sessionId || 'unknown',
      created_at:        record.time || new Date().toISOString(),
      job:               String(record.job ?? ''),
      frame:             String(record.frame ?? ''),
      camera:            record.camera   || null,
      action:            record.action,
      how:               record.how      || null,
      model:             record.model    || null,
      label:             record.label    || null,
      score:             record.score    ?? null,
      points:            record.points   ?? null,
      edited:            record.edited   ?? null,
      iou:               record.iou      ?? null,
      dyaw_deg:          record.dyaw     ?? null,
      label_changed:     record.labelChanged ?? null,
      time_spent_seconds: record.time_spent_seconds ?? null,
      track_id:          record.trackId != null ? String(record.trackId) : null,   // CVAT id of the track (opaque), if the box belongs to one
      n_adjust:          record.nAdjust ?? null,                                  // edits made to the box before it was saved
      arm:               record.arm ?? null,
      extension_version: VERSION,
      downloaded:        false,
    };

    // Thử gửi ngay; nếu lỗi → enqueue
    try {
      await flushQueue(cfg, deviceId);    // flush pending trước
      await rest(cfg, 'POST', TABLE, [row]);
      await noteSync(null);
    } catch (e) {
      // lỗi đăng nhập ẩn danh, mạng hay server: log nằm lại trong queue, trang Log báo đang chờ gửi và lỗi gì
      console.warn('[SupaLog] push failed, queuing', e.message);
      await enqueue(row, e.message);
    }
  }

  /**
   * Đẩy tổng kết phiên lên Supabase (bảng annotation_sessions).
   * Dùng UPSERT để lưu tóm tắt định lượng (speedup, IoU, yaw error, thời gian tiết kiệm).
   * @param {object} s — đối tượng phiên từ SessionManager.finishSession()
   */
  async function pushSession(s) {
    if (!s || !s.session_id) return;
    let cfg, deviceId;
    try {
      cfg = await cachedConfig();
      if (!cfg) return;
      deviceId = await getDeviceId();
    } catch { return; }

    const row = {
      session_id:           s.session_id,
      device_id:            deviceId,
      job_id:               String(s.job_id ?? ''),
      task_name:            null,   // never sent: a task name can carry dataset / scene names (the log holds numbers and opaque ids only)
      started_at:           s.started_at || new Date().toISOString(),
      ended_at:             s.status === 'completed' ? (s.ended_at || new Date().toISOString()) : null,   // null while active / paused
      status:               s.status || 'completed',
      ended_reason:         s.ended_reason || null,
      resumed_count:        s.resumed_count || 0,
      last_activity_at:     s.last_activity_at || null,
      frame_times:          s.frame_times || {},
      params:               s.params || null,
      tracks_created:       s.tracks_created || 0,
      duration_seconds:     s.duration_seconds || 0,
      total_paused_seconds: s.total_paused_seconds || 0,
      total_actions:        s.total_actions || 0,
      saved_boxes:          s.saved_boxes || 0,
      manual_count:         s.manual_count || 0,
      tool_count:           s.tool_count || 0,
      avg_seconds_manual:   s.avg_seconds_per_box_manual || null,
      avg_seconds_tool:     s.avg_seconds_per_box_tool || null,
      speedup_factor:       s.speedup_factor || null,
      time_saved_seconds:   s.time_saved_seconds || 0,
      avg_iou:              s.avg_iou || null,
      avg_yaw_deg:          s.avg_yaw_deg || null,
      edit_rate_pct:        s.edit_rate_pct || null,
      tool_breakdown:       s.tool_breakdown || {},
      class_stats:          s.class_stats || {}
    };

    try {
      await rest(cfg, 'POST', SESSIONS_TABLE, row, null, 'resolution=merge-duplicates,return=minimal');
      await queued(() => dropPendingSession(row.session_id));   // bản cũ còn treo của phiên này đã bị bản mới đè
      await noteSync(null);
    } catch (e) {
      console.warn('[SupaLog] pushSession failed, kept for retry', e.message);
      await keepPendingSession(row, e.message);
    }
  }

  /**
   * Lấy danh sách session đã lưu trên Supabase của device này (từ bảng annotation_sessions).
   */
  async function getCloudSessions() {
    const cfg = await cachedConfig();
    if (!cfg) return [];
    try {
      const deviceId = await ownerId(cfg);
      const rows = await rest(cfg, 'GET', SESSIONS_TABLE, null, {
        select:    '*',
        device_id: `eq.${deviceId}`,
        order:     'started_at.desc',
        limit:     '500',
      });
      return rows || [];
    } catch (e) {
      console.warn('[SupaLog] getCloudSessions failed', e.message);
      return [];
    }
  }

  /**
   * Lấy danh sách phiên (session) của device này, mới nhất trước.
   * Trả về [{session_id, started_at, count}]
   */
  async function getSessions() {
    const cfg = await getConfig();
    if (!cfg) return [];
    const deviceId = await ownerId(cfg);

    // Lấy tất cả log của device rồi group ở client (tránh phụ thuộc RPC)
    const rows = await rest(cfg, 'GET', TABLE, null, {
      select:    'session_id,created_at',
      device_id: `eq.${deviceId}`,
      order:     'created_at.desc',
      limit:     '5000',
    });
    if (!rows || !rows.length) return [];

    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.session_id)) {
        map.set(r.session_id, { session_id: r.session_id, started_at: r.created_at, count: 0 });
      }
      map.get(r.session_id).count++;
    }
    return [...map.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  /**
   * Lấy toàn bộ log của 1 phiên (hoặc tất cả phiên nếu sessionId = null).
   * Trả về mảng record, mới nhất trước.
   */
  async function getLogs(sessionId) {
    const cfg = await getConfig();
    if (!cfg) return [];
    const deviceId = await ownerId(cfg);

    const params = {
      select:    '*',
      device_id: `eq.${deviceId}`,
      order:     'created_at.desc',
      limit:     '10000',
    };
    if (sessionId) params.session_id = `eq.${sessionId}`;

    return (await rest(cfg, 'GET', TABLE, null, params)) || [];
  }

  /**
   * Đánh dấu các record đã tải về (downloaded = TRUE).
   * Log đã tải không bị cron xoá.
   * @param {number[]} ids — mảng id record
   */
  async function markDownloaded(ids) {
    if (!ids || !ids.length) return;
    const cfg = await getConfig();
    if (!cfg) return;
    // Supabase REST: PATCH với filter `id=in.(1,2,3)`
    await rest(cfg, 'PATCH', TABLE, { downloaded: true }, {
      id: `in.(${ids.join(',')})`,
    });
  }

  /**
   * Xoá toàn bộ log của 1 phiên.
   */
  async function deleteSession(sessionId) {
    const cfg = await getConfig();
    if (cfg) {
      const deviceId = await ownerId(cfg);
      await rest(cfg, 'DELETE', TABLE, null, {
        device_id:  `eq.${deviceId}`,
        session_id: `eq.${sessionId}`,
      });
      return;
    }
    // Fallback: xoá trong chrome.storage.local
    const all = await chrome.storage.local.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('editlog:') && Array.isArray(v)) {
        const next = v.filter((item) => (item.session_id || 'local-session') !== sessionId);
        await chrome.storage.local.set({ [k]: next });
      }
    }
  }

  /**
   * Xoá toàn bộ log của device này.
   */
  async function deleteAll() {
    const cfg = await getConfig();
    if (cfg) {
      const deviceId = await ownerId(cfg);
      await rest(cfg, 'DELETE', TABLE, null, {
        device_id: `eq.${deviceId}`,
      });
      return;
    }
    // Fallback: xoá trong chrome.storage.local
    const all = await chrome.storage.local.get(null);
    const removeKeys = Object.keys(all).filter((k) => k.startsWith('editlog:'));
    if (removeKeys.length) {
      await chrome.storage.local.remove(removeKeys);
    }
  }

  /**
   * Lưu cấu hình Supabase (gọi từ options.js).
   */
  async function saveConfig(url, anonKey) {
    const cfg = { url: url.replace(/\/$/, ''), anonKey };
    await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
    _cfgCache = null;   // invalidate cache
  }

  /**
   * Xoá cấu hình Supabase.
   */
  async function clearConfig() {
    await chrome.storage.local.remove(CONFIG_KEY);
    _cfgCache = null;
  }

  /**
   * Lấy log lưu local trong chrome.storage.local (dùng khi chưa cấu hình Supabase).
   */
  async function getLocalLogs() {
    const all = await chrome.storage.local.get(null);
    const out = [];
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('editlog:') && Array.isArray(v)) {
        for (const item of v) {
          out.push({
            id: out.length + 1,
            created_at: item.time,
            session_id: item.session_id || 'local-session',
            job: item.job || '',
            frame: item.frame || '',
            camera: item.camera || '',
            action: item.action || 'save',
            how: item.how || '',
            model: item.model || '',
            label: item.label || item.labelName || '',
            score: item.score != null ? item.score : null,
            points: item.points != null ? item.points : null,
            edited: !!item.edited,
            iou: item.iou != null ? item.iou : null,
            dyaw_deg: item.dyaw != null ? item.dyaw : (item.dyaw_deg != null ? item.dyaw_deg : null),
            label_changed: !!item.labelChanged,
            extension_version: VERSION,
            downloaded: false
          });
        }
      }
    }
    return out.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }

  // ── Quỹ đạo ego (pose) theo task: mỗi thiết bị chỉ ghi và đọc dòng của chính mình ───

  const POSES_TABLE = 'task_poses';

  /** Quỹ đạo của 1 task, do thiết bị này đẩy: dòng mang owner_device_id = thiết bị này, khoá (task_name, owner_device_id) nên hai người
   *  cùng tên task không đè nhau, và RLS chỉ cho thiết bị đó đọc / ghi dòng của mình. Không throw. */
  async function upsertTaskPose({ taskName, taskId, source, rawPose, frameCount }) {
    const cfg = await cachedConfig();
    if (!cfg || !taskName) return false;
    try {
      const row = { task_name: String(taskName), owner_device_id: await ownerId(cfg), task_id: taskId != null ? String(taskId) : null, source: source || null,
        frame_count: frameCount || 0, raw_pose: rawPose, updated_at: new Date().toISOString() };
      await rest(cfg, 'POST', POSES_TABLE, row, { on_conflict: 'task_name,owner_device_id' }, 'resolution=merge-duplicates,return=minimal');
      return true;
    } catch (e) { console.warn('[SupaLog] upsertTaskPose failed', e.message); return false; }
  }

  /** Quỹ đạo của task do chính thiết bị này đã đẩy (null nếu không có / lỗi: extension tự tính KISS-ICP hoặc nạp file). */
  async function getTaskPose(taskName) {
    const cfg = await cachedConfig();
    if (!cfg || !taskName) return null;
    try {
      // the table's RLS only shows the rows whose owner_device_id is this device (the JWT's auth.uid()); filter too
      const deviceId = await ownerId(cfg);
      const rows = await rest(cfg, 'GET', POSES_TABLE, null, { select: 'source,raw_pose', task_name: `eq.${taskName}`, owner_device_id: `eq.${deviceId}`, limit: '1' });
      return rows && rows[0] || null;
    } catch (e) { console.warn('[SupaLog] getTaskPose failed', e.message); return null; }
  }

  const api = { push, pushSession, getCloudSessions, isConfigured, getConfig, getSessions, getLogs, markDownloaded,
    deleteSession, deleteAll, saveConfig, clearConfig, getDeviceId, getLocalLogs, upsertTaskPose, getTaskPose, syncStatus };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SupaLog = api;
})(typeof self !== 'undefined' ? self : this);
