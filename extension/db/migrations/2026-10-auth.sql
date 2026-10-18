-- 2026-10-auth.sql — chạy MỘT LẦN trong Supabase SQL Editor (an toàn khi chạy lại).
--
-- Vì sao: RLS cũ tin header 'x-device-id' do client tự gửi, mà cả nhóm dùng chung anon key. Ai biết device_id của người khác chỉ cần gắn
-- header đó là đọc, sửa, xoá được phiên và log của họ. Từ bản này mỗi máy đăng nhập ẩn danh và RLS so với auth.uid() trong JWT do
-- Supabase ký.
--
-- TRƯỚC KHI CHẠY: Authentication → Providers → bật "Allow anonymous sign-ins". Rồi phát hành extension bản mới cùng lúc: bản
-- extension cũ (chỉ gửi header) sẽ không còn ghi được lên Supabase. Log chưa gửi được xếp hàng trong máy và tự gửi lại khi bản mới chạy.
--
-- LƯU Ý: dòng đã có từ trước mang device_id ngẫu nhiên cũ nên không còn hiện ra trên extension (không ai khớp auth.uid()).
-- Quản trị viên vẫn xem được trong Supabase Studio.

DO $$
DECLARE
  t record;
  p record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('edit_logs',           'device_id',       true),
    ('annotation_sessions', 'device_id',       true),
    ('task_poses',          'owner_device_id', false)   -- không có DELETE: annotator không xoá được pose
  ) AS v(tbl, col, can_delete)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tbl);

    -- bỏ mọi policy cũ (header x-device-id, anon_all, ...)
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t.tbl LOOP
      EXECUTE format('DROP POLICY %I ON %I', p.policyname, t.tbl);
    END LOOP;

    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (%I = (select auth.uid())::text)',
                   'own_select_' || t.tbl, t.tbl, t.col);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (%I = (select auth.uid())::text)',
                   'own_insert_' || t.tbl, t.tbl, t.col);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (%I = (select auth.uid())::text) WITH CHECK (%I = (select auth.uid())::text)',
                   'own_update_' || t.tbl, t.tbl, t.col, t.col);
    IF t.can_delete THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (%I = (select auth.uid())::text)',
                     'own_delete_' || t.tbl, t.tbl, t.col);
    END IF;

    -- chỉ có anon key (không JWT) thì không chạm được bảng
    EXECUTE format('REVOKE ALL ON %I FROM anon', t.tbl);
  END LOOP;
END $$;
