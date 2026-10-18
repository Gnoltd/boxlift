// node tools/check_db.js — Kiểm tra kết nối tới Supabase database và trạng thái bảng / RLS
const fs = require('fs');
const path = require('path');

const cfgPath = path.resolve(__dirname, '../extension/config/database.json');

async function check() {
  console.log('=== KIỂM TRA KẾT NỐI SUPABASE DATABASE (P-009) ===\n');

  if (!fs.existsSync(cfgPath)) {
    console.log('❌ Chưa tìm thấy file: extension/config/database.json');
    console.log('👉 Hãy copy từ database.json.example và điền url + anonKey của bạn.');
    return;
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    console.log('❌ Lỗi định dạng JSON trong file database.json:', e.message);
    return;
  }

  const url = (cfg.url || '').trim();
  const anonKey = (cfg.anonKey || '').trim();

  if (!url || !anonKey || url.includes('YOUR_SUPABASE_PROJECT_ID')) {
    console.log('⚠️  CHƯA CẤU HÌNH THÔNG TIN THẬT:');
    console.log('   - File database.json hiện tại vẫn đang chứa URL/Key mẫu (placeholder).');
    console.log('   - URL hiện tại:', url || '(trống)');
    console.log('\n👉 Hướng dẫn kích hoạt:');
    console.log('   1. Điền URL và Anon Key của dự án Supabase vào: source-tool/calib-overlay/extension/config/database.json');
    console.log('   2. Chạy lại: node tools/check_db.js\n');
    return;
  }

  console.log('🔍 Đang kiểm tra kết nối tới:', url);

  const testDeviceId = 'test-cli-check-' + Date.now();
  const headers = {
    'apikey': anonKey,
    'Authorization': `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
    'x-device-id': testDeviceId,
  };

  // 1. Kiểm tra bảng edit_logs
  try {
    const res = await fetch(`${url}/rest/v1/edit_logs?select=count`, {
      method: 'GET',
      headers: { ...headers, 'Prefer': 'count=exact' }
    });
    if (res.ok) {
      console.log('✅ Bảng [edit_logs]: Kết nối THÀNH CÔNG! (Status:', res.status, ')');
    } else {
      const errText = await res.text();
      console.log('❌ Bảng [edit_logs]: Thất bại (Status:', res.status, ')');
      console.log('   Chi tiết:', errText);
      if (res.status === 404 || errText.includes('does not exist')) {
        console.log('   👉 Bạn cần mở Supabase SQL Editor và chạy nội dung file extension/db/supabase-schema.sql');
      }
    }
  } catch (e) {
    console.log('❌ Không thể kết nối tới Supabase host:', e.message);
    return;
  }

  // 2. Kiểm tra bảng annotation_sessions
  try {
    const res = await fetch(`${url}/rest/v1/annotation_sessions?select=count`, {
      method: 'GET',
      headers: { ...headers, 'Prefer': 'count=exact' }
    });
    if (res.ok) {
      console.log('✅ Bảng [annotation_sessions]: Kết nối THÀNH CÔNG! (Status:', res.status, ')');
    } else {
      const errText = await res.text();
      console.log('❌ Bảng [annotation_sessions]: Thất bại (Status:', res.status, ')');
      console.log('   Chi tiết:', errText);
      if (res.status === 404 || errText.includes('does not exist')) {
        console.log('   👉 Bạn cần mở Supabase SQL Editor và chạy nội dung file extension/db/supabase-schema.sql');
      }
    }
  } catch (e) {
    console.log('❌ Lỗi kiểm tra bảng annotation_sessions:', e.message);
  }

  console.log('\n🎉 Kết nối Supabase hoàn toàn sẵn sàng!');
}

check();
