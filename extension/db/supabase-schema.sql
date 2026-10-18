-- =============================================================
-- calib-overlay: Log thao tác & Quản lý phiên trên Supabase (P-009)
-- Chạy toàn bộ file này trong Supabase SQL Editor (1 lần duy nhất).
--
-- TÍNH NĂNG BẢO MẬT & PHÂN QUYỀN:
--  - Cấu hình 1 lần cho cả nhóm bằng file `extension/config/database.json`.
--  - Mỗi máy đăng nhập ẩn danh (Supabase Anonymous Sign-ins) và gửi JWT; Row Level Security (RLS) so device_id với auth.uid():
--    mỗi annotator chỉ có quyền SELECT / INSERT / UPDATE / DELETE các phiên và log thuộc về chính danh tính của họ.
--  - Danh tính do Supabase ký, không giả được bằng cách tự gắn header. Chỉ có anon key thì không đọc được gì.
--  - Quản trị viên (Admin/Lead) xem toàn bộ dữ liệu qua Supabase Studio
--    hoặc dùng service_role key (bỏ qua RLS).
-- =============================================================

-- ── 1. Bảng chi tiết từng thao tác gán nhãn ────────────────────────────────
CREATE TABLE IF NOT EXISTS edit_logs (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id           TEXT NOT NULL,       -- UUID định danh máy trong chrome.storage.local
  session_id          TEXT NOT NULL,       -- UUID phiên làm việc
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Dữ liệu thao tác (từ editlog.js & session.js)
  job                 TEXT,                -- ID job CVAT
  frame               TEXT,                -- frame index
  camera              TEXT,                -- tên camera chiếu
  action              TEXT NOT NULL,       -- 'save' | 'skip'
  how                 TEXT,                -- 'tay' | 'T' (auto) | 'lan'/'tracker' | 'learned'
  model               TEXT,                -- mô hình: mtrans, frustum, geometry...
  label               TEXT,                -- tên nhãn vật thể
  score               REAL,                -- độ tin cậy mô hình
  points              INT,                 -- số điểm LiDAR bên trong box
  edited              BOOLEAN,             -- true nếu người dùng có kéo chỉnh lại
  iou                 REAL,                -- 3D IoU so với đề xuất máy
  dyaw_deg            REAL,                -- sai số góc yaw (độ)
  label_changed       BOOLEAN,             -- true nếu đổi tên nhãn
  time_spent_seconds  REAL,                -- thời gian gán nhãn box này (giây)

  -- Metadata
  extension_version   TEXT,
  downloaded          BOOLEAN NOT NULL DEFAULT FALSE
);

-- Thêm cột time_spent_seconds nếu bảng đã tồn tại từ phiên bản trước
ALTER TABLE edit_logs ADD COLUMN IF NOT EXISTS time_spent_seconds REAL;

-- ── 2. Bảng tổng kết phiên làm việc (Session Summary) ───────────────────────
CREATE TABLE IF NOT EXISTS annotation_sessions (
  session_id          TEXT PRIMARY KEY,    -- UUID phiên
  device_id           TEXT NOT NULL,       -- UUID máy của annotator
  job_id              TEXT,                -- CVAT Job ID
  task_name           TEXT,                -- Tên task CVAT
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  duration_seconds    INT NOT NULL DEFAULT 0,
  total_paused_seconds REAL NOT NULL DEFAULT 0,
  total_actions       INT NOT NULL DEFAULT 0,
  saved_boxes         INT NOT NULL DEFAULT 0,
  manual_count        INT NOT NULL DEFAULT 0,
  tool_count          INT NOT NULL DEFAULT 0,
  avg_seconds_manual  REAL,
  avg_seconds_tool    REAL,
  speedup_factor      REAL,
  time_saved_seconds  INT NOT NULL DEFAULT 0,
  avg_iou             REAL,
  avg_yaw_deg         REAL,
  edit_rate_pct       REAL,
  tool_breakdown      JSONB,               -- Chi tiết số lượng theo tool: auto_3d, tracker...
  class_stats         JSONB,               -- Thống kê năng suất theo từng lớp đối tượng
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 3. Chỉ mục (Indexes) tăng tốc độ truy vấn ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_logs_device_session ON edit_logs (device_id, session_id);
CREATE INDEX IF NOT EXISTS idx_logs_device_created ON edit_logs (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_created ON edit_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_sessions_device_started ON annotation_sessions (device_id, started_at DESC);

-- ── 4. Row Level Security (RLS) — Cô lập dữ liệu theo danh tính đăng nhập ẩn danh ──
-- Mỗi máy đăng nhập ẩn danh (Authentication → Providers → bật "Allow anonymous sign-ins") và gửi JWT do Supabase ký.
-- Máy chỉ đọc / ghi được dòng có device_id = auth.uid() của JWT đó. Không còn tin header 'x-device-id' tự khai (ai cũng giả được).
-- Chỉ có anon key, không có JWT: không đọc được gì. Project đang chạy bản cũ: chạy db/migrations/2026-10-auth.sql.

ALTER TABLE edit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE annotation_sessions ENABLE ROW LEVEL SECURITY;

-- Dọn dẹp chính sách cũ nếu có
DROP POLICY IF EXISTS "anon_select" ON edit_logs;
DROP POLICY IF EXISTS "anon_insert" ON edit_logs;
DROP POLICY IF EXISTS "anon_update" ON edit_logs;
DROP POLICY IF EXISTS "anon_delete" ON edit_logs;
DROP POLICY IF EXISTS "device_select_own" ON edit_logs;
DROP POLICY IF EXISTS "device_insert_own" ON edit_logs;
DROP POLICY IF EXISTS "device_update_own" ON edit_logs;
DROP POLICY IF EXISTS "device_delete_own" ON edit_logs;

-- RLS cho bảng edit_logs
CREATE POLICY "device_select_own" ON edit_logs
  FOR SELECT TO authenticated
  USING (
    device_id = (select auth.uid())::text
  );

CREATE POLICY "device_insert_own" ON edit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    device_id = (select auth.uid())::text
  );

CREATE POLICY "device_update_own" ON edit_logs
  FOR UPDATE TO authenticated
  USING (
    device_id = (select auth.uid())::text
  )
  WITH CHECK (
    device_id = (select auth.uid())::text
  );

CREATE POLICY "device_delete_own" ON edit_logs
  FOR DELETE TO authenticated
  USING (
    device_id = (select auth.uid())::text
  );

-- RLS cho bảng annotation_sessions
DROP POLICY IF EXISTS "device_select_own_sessions" ON annotation_sessions;
DROP POLICY IF EXISTS "device_insert_own_sessions" ON annotation_sessions;
DROP POLICY IF EXISTS "device_update_own_sessions" ON annotation_sessions;
DROP POLICY IF EXISTS "device_delete_own_sessions" ON annotation_sessions;

CREATE POLICY "device_select_own_sessions" ON annotation_sessions
  FOR SELECT TO authenticated
  USING (
    device_id = (select auth.uid())::text
  );

CREATE POLICY "device_insert_own_sessions" ON annotation_sessions
  FOR INSERT TO authenticated
  WITH CHECK (
    device_id = (select auth.uid())::text
  );

CREATE POLICY "device_update_own_sessions" ON annotation_sessions
  FOR UPDATE TO authenticated
  USING (
    device_id = (select auth.uid())::text
  )
  WITH CHECK (
    device_id = (select auth.uid())::text
  );

CREATE POLICY "device_delete_own_sessions" ON annotation_sessions
  FOR DELETE TO authenticated
  USING (
    device_id = (select auth.uid())::text
  );

-- ── 5. Tự động xoá log cũ chưa tải (> 30 ngày) ──────────────────────────────
-- Yêu cầu: Bật extension pg_cron trong Supabase Dashboard → Database → Extensions.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'calib_overlay_cleanup_old_logs',
      '0 2 * * *',   -- Mỗi ngày lúc 02:00 UTC
      $cmd$
        DELETE FROM edit_logs
        WHERE created_at < now() - INTERVAL '30 days'
          AND downloaded = FALSE;
      $cmd$
    );
  END IF;
END $$;

-- ── 6. Quỹ đạo ego theo task (KISS-ICP): mỗi thiết bị chỉ ghi và đọc dòng của chính mình ──
-- Pose thô vẫn được đẩy lên (supalog.js upsertTaskPose) nhưng gắn owner_device_id = auth.uid() của thiết bị đẩy; RLS chỉ cho đúng thiết bị đó
-- SELECT / INSERT / UPDATE dòng của mình. Không có DELETE. Các dòng đẩy từ trước chưa có chủ bị xoá khi chạy file này (xem ghi chú bên dưới).
CREATE TABLE IF NOT EXISTS task_poses (
  task_name   TEXT NOT NULL,
  task_id     TEXT,
  source      TEXT,
  frame_count INT NOT NULL DEFAULT 0,
  raw_pose    JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE task_poses ADD COLUMN IF NOT EXISTS owner_device_id TEXT;
-- XOÁ VĨNH VIỄN các pose đã đẩy trước đây (chưa có chủ). Ai cần thì nạp file ego pose / bấm "Tự tính quỹ đạo" lại ở máy mình
-- (lần đó pose được đẩy lại, mang owner_device_id của máy đó).
DELETE FROM task_poses WHERE owner_device_id IS NULL;
ALTER TABLE task_poses ALTER COLUMN owner_device_id SET NOT NULL;
-- Khoá (task_name, owner_device_id): hai người cùng tên task không đè nhau.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'task_poses'::regclass AND conname = 'task_poses_pkey'
             AND pg_get_constraintdef(oid) = 'PRIMARY KEY (task_name)') THEN
    ALTER TABLE task_poses DROP CONSTRAINT task_poses_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'task_poses'::regclass AND contype = 'p') THEN
    ALTER TABLE task_poses ADD PRIMARY KEY (task_name, owner_device_id);
  END IF;
END $$;
ALTER TABLE task_poses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_task_poses" ON task_poses;
DROP POLICY IF EXISTS "anon_select_task_poses" ON task_poses;
DROP POLICY IF EXISTS "anon_insert_task_poses" ON task_poses;
DROP POLICY IF EXISTS "anon_update_task_poses" ON task_poses;
DROP POLICY IF EXISTS "device_select_own_poses" ON task_poses;
DROP POLICY IF EXISTS "device_insert_own_poses" ON task_poses;
DROP POLICY IF EXISTS "device_update_own_poses" ON task_poses;
CREATE POLICY "device_select_own_poses" ON task_poses
  FOR SELECT TO authenticated
  USING (owner_device_id = (select auth.uid())::text);
CREATE POLICY "device_insert_own_poses" ON task_poses
  FOR INSERT TO authenticated
  WITH CHECK (owner_device_id = (select auth.uid())::text);
CREATE POLICY "device_update_own_poses" ON task_poses
  FOR UPDATE TO authenticated
  USING (owner_device_id = (select auth.uid())::text)
  WITH CHECK (owner_device_id = (select auth.uid())::text);
-- Không có policy DELETE: annotator không xoá được pose.

-- ── 7. Phiên làm việc v2 ────────────────────────────────────────────────────
-- Cột mới của annotation_sessions / edit_logs, dọn số giả và tên task: xem db/migrations/2026-10-session-v2.sql
-- (chạy file đó một lần trên project đang dùng; project mới chạy file này rồi chạy file migration).
