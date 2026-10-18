-- 2026-10-session-v2.sql — chạy MỘT LẦN trong Supabase SQL Editor (an toàn khi chạy lại).
-- Quy tắc: log chỉ có SỐ ĐO và ĐỊNH DANH VÔ NGHĨA. Không tên file / task / scene, không hộp, không pose, không calib.

-- ── 1. annotation_sessions: trạng thái phiên (tạm dừng, tiếp tục, lý do kết thúc) và dữ liệu thời gian ──
ALTER TABLE annotation_sessions ADD COLUMN IF NOT EXISTS status           TEXT;          -- 'active' | 'paused' | 'completed'
ALTER TABLE annotation_sessions ADD COLUMN IF NOT EXISTS ended_reason     TEXT;          -- 'saved' | 'exit' | 'stale'
ALTER TABLE annotation_sessions ADD COLUMN IF NOT EXISTS resumed_count    INT NOT NULL DEFAULT 0;
ALTER TABLE annotation_sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
ALTER TABLE annotation_sessions ADD COLUMN IF NOT EXISTS frame_times      JSONB;         -- { "<chỉ số frame>": {tool_s, manual_s, panel_s, boxes} }
ALTER TABLE annotation_sessions ADD COLUMN IF NOT EXISTS params           JSONB;         -- ngưỡng tính giờ và ngưỡng "box đã sửa" dùng cho phiên này
ALTER TABLE annotation_sessions ADD COLUMN IF NOT EXISTS tracks_created   INT NOT NULL DEFAULT 0;

-- Phiên đã đẩy từ trước coi như đã hoàn tất
UPDATE annotation_sessions SET status = 'completed' WHERE status IS NULL AND ended_at IS NOT NULL;

-- Phiên tạm dừng chưa có giờ kết thúc: bỏ NOT NULL / mặc định không hợp lý nếu có
ALTER TABLE annotation_sessions ALTER COLUMN ended_at DROP NOT NULL;
-- "chưa đo" phải là NULL, không phải 0
ALTER TABLE annotation_sessions ALTER COLUMN speedup_factor     DROP NOT NULL;
ALTER TABLE annotation_sessions ALTER COLUMN avg_seconds_manual DROP NOT NULL;
ALTER TABLE annotation_sessions ALTER COLUMN time_saved_seconds DROP NOT NULL;

-- ── 2. Dọn dữ liệu cũ ──
-- Tên task có thể chứa tên dataset / scene: không lưu nữa
UPDATE annotation_sessions SET task_name = NULL;
-- Số "tăng tốc" cũ dùng mốc làm tay cố định 45 s/box khi phiên không có số đo làm tay: xoá
UPDATE annotation_sessions
   SET speedup_factor = NULL, avg_seconds_manual = NULL, time_saved_seconds = 0
 WHERE manual_count = 0;

-- ── 3. edit_logs: định danh track, số lần chỉnh, nhóm thí nghiệm (arm) ──
ALTER TABLE edit_logs ADD COLUMN IF NOT EXISTS track_id TEXT;    -- id track của CVAT (nếu box thuộc track có sẵn)
ALTER TABLE edit_logs ADD COLUMN IF NOT EXISTS n_adjust INT;     -- số lần chỉnh box trước khi lưu
ALTER TABLE edit_logs ADD COLUMN IF NOT EXISTS arm      TEXT;    -- chưa dùng (để NULL)

-- ── 4. Pose theo task: mỗi thiết bị chỉ ghi và đọc dòng của chính mình ──
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
DROP POLICY IF EXISTS "anon_all_task_poses" ON task_poses;
DROP POLICY IF EXISTS "anon_select_task_poses" ON task_poses;
DROP POLICY IF EXISTS "anon_insert_task_poses" ON task_poses;
DROP POLICY IF EXISTS "anon_update_task_poses" ON task_poses;
DROP POLICY IF EXISTS "device_select_own_poses" ON task_poses;
DROP POLICY IF EXISTS "device_insert_own_poses" ON task_poses;
DROP POLICY IF EXISTS "device_update_own_poses" ON task_poses;
CREATE POLICY "device_select_own_poses" ON task_poses
  FOR SELECT TO anon
  USING (owner_device_id = coalesce(current_setting('request.headers', true)::json->>'x-device-id', ''));
CREATE POLICY "device_insert_own_poses" ON task_poses
  FOR INSERT TO anon
  WITH CHECK (owner_device_id = coalesce(current_setting('request.headers', true)::json->>'x-device-id', ''));
CREATE POLICY "device_update_own_poses" ON task_poses
  FOR UPDATE TO anon
  USING (owner_device_id = coalesce(current_setting('request.headers', true)::json->>'x-device-id', ''))
  WITH CHECK (owner_device_id = coalesce(current_setting('request.headers', true)::json->>'x-device-id', ''));
-- Không có policy DELETE: annotator không xoá được pose.
-- LƯU Ý: lệnh DELETE ở trên xoá vĩnh viễn mọi pose đã đẩy trước đây (không có chủ). Pose của mỗi người từ nay do chính máy đó đẩy lại.
