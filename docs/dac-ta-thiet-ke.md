# BoxLift: tài liệu đặc tả và thiết kế

Phiên bản mô tả: `0.19.2`. Sơ đồ kiến trúc: [`architecture.md`](architecture.md). Hướng dẫn cài và dùng: [`README.md`](../README.md).
Kế hoạch và phân công: [`PLAN.md`](../PLAN.md). Cơ sở khoa học của từng thành phần: [`RESEARCH.md`](../RESEARCH.md).

## 1. Mục đích và phạm vi

### 1.1 Bài toán

Gán cuboid 3D trên CVAT bắt người gán nhìn qua lại giữa ảnh camera 2D và point cloud 3D bằng mắt, vì CVAT không chiếu
điểm LiDAR hay cuboid lên ảnh. Thực tế tuần 03 mất khoảng 71–128 phút mỗi frame
(P-014, backlog-time.md (tài liệu nội bộ của nhóm)).

### 1.2 Mục tiêu

| # | Mục tiêu | Cách đo |
|---|---|---|
| G1 | Giảm thời gian gán mỗi cuboid so với làm tay trên CVAT | Giây mỗi cuboid, Làm tay vs Dùng tool |
| G2 | Box máy dựng ra gần với box đáp án, ít phải sửa | IoU 3D, lệch tâm, lệch hướng (yaw), tỉ lệ box phải sửa |
| G3 | Dùng được ngay trong CVAT, không đổi quy trình lưu | Box lưu thẳng vào job CVAT đang mở |
| G4 | Không đưa dữ liệu gán nhãn ra ngoài máy người dùng | Suy luận và tính toán chạy trong trình duyệt |

### 1.3 Ngoài phạm vi (MVP)

Camera fisheye với đáp án đo riêng, LiDAR dày, mô hình 3D cho xe tải/buýt/người ở độ chính xác của MTrans, phát hành lên
Chrome Web Store. Các hướng này nằm trong mục "Hướng phát triển" của README.

## 2. Người dùng và bối cảnh

| Vai trò | Việc với BoxLift |
|---|---|
| Annotator | Kéo khung 2D hoặc bấm `T`, duyệt, chỉnh, lưu box; dùng Track 3D cho vật thể nhiều frame |
| Reviewer | Mở lại job CVAT, box đã là cuboid CVAT bình thường |
| Lead | Cài extension, nạp calib cho dữ liệu mới, xuất bảng số liệu Làm tay vs Dùng tool |

Môi trường: Chrome (hoặc nhân Chromium) với Manifest V3; CVAT tại `app.cvat.ai`, `localhost:8080`, hoặc domain riêng do
người dùng cấp quyền; job 3D có point cloud kèm ảnh camera.

## 3. Đặc tả chức năng

Trạng thái: **Có** là đã chạy trong `0.19.2`. Cột "Kiểm thử" trỏ tới file test trong `tests/`.

| Mã | Chức năng | Mô tả hành vi | Trạng thái | Kiểm thử |
|---|---|---|---|---|
| FR-01 | Chiếu LiDAR lên ảnh | Với mỗi camera, vẽ điểm LiDAR lên ảnh theo calib, tô màu theo khoảng cách; bật tắt bằng `H`, ẩn mặt đất bằng `G` | Có | `ground.test.js`, `parity.test.js`, `timeoffset.test.js` |
| FR-02 | Chọn calib | Thứ tự: calib đã lưu cho task, rồi khớp tên task với bộ có sẵn, rồi người dùng chọn tay hoặc nạp `calib.json`. Không có calib thì báo rõ và không chiếu | Có | không có test tự động |
| FR-03 | Chỉnh calib | Chỉnh 7 thông số (pan, tilt, roll, dx, dy, dz, tỉ lệ tiêu cự), hoặc giải từ các cặp điểm LiDAR–pixel người dùng bấm; xuất `calib.json` | Có | `pairs.test.js`, `pairs_report.test.js` |
| FR-04 | Khung 2D thành box 3D | `N` rồi kéo khung quanh vật thể; trả box 3D (tâm, kích thước, yaw) kể cả phần bị khuất | Có | `frustum.test.js`, `mtrans.test.js`, `split.test.js`, `boxfit.bench.js` |
| FR-05 | Tự động đề xuất | `T` (1 camera) và `Shift+T` (mọi camera): mô hình nhận diện khoanh vật thể, mỗi khung thành một box đề xuất để duyệt | Có | `detect.test.js`, `objects.test.js` |
| FR-06 | Chọn mô hình theo lớp | Xe con: MTrans; xe tải, buýt, xe đạp, người: Frustum PointNet; xe máy và dự phòng: hình học. Chọn theo lớp vật thể, không theo tên nhãn | Có | `labelmap.test.js` |
| FR-07 | Hướng đầu/đuôi | Từ trục xe do LiDAR cho (L-shape), mô hình ảnh chọn đầu hay đuôi | Có | `heading.test.js` |
| FR-08 | Lọc đề xuất | Ngưỡng tin cậy theo lớp, số điểm LiDAR tối thiểu, ghi lý do khi một khung bị loại; đổi ngưỡng chỉ lọc lại, không chạy lại mô hình | Có | `autofilter.test.js` |
| FR-09 | Nhãn độ tin cậy | Mỗi box máy hiện "loại, %" tô theo mức cao, trung bình, thấp, và cảnh báo khi ít điểm LiDAR hoặc đầu/đuôi chưa chắc | Có | `boxtag.test.js` |
| FR-10 | Duyệt và chỉnh | `Enter` lưu và sang box kế, `X` bỏ, `Tab` để sau, `Shift+Enter` lưu tất cả; kéo tay cầm trên ảnh, 3 khung nhìn Trên/Hông/Trước, phím mũi tên, nhập số trực tiếp; hoàn tác/làm lại | Có | `handles.test.js`, `geometry.test.js` |
| FR-11 | Lưu vào CVAT | Lưu thành shape hoặc track CVAT qua REST, bằng phiên đăng nhập của người dùng | Có | `bridge.test.js` (lấy frame từ CVAT) |
| FR-12 | Track 3D | `Shift+K`: từ box ở frame đầu, bám vật thể qua N frame, giữ một ID, chốt một kích thước; vật đứng im cố định trong hệ toạ độ thế giới, vật di chuyển dự đoán theo vận tốc rồi khớp lại với điểm. `K` đặt keyframe, các frame giữa tự nội suy | Có | `propagate.bench.js`, `scan.test.js`, `egopath.test.js`, `anchors.test.js`, `static_anchor.test.js` |
| FR-13 | Chuyển động xe | Dùng pose từng frame nếu nạp `lidar_metadata.json`; không có thì tự ước lượng bằng ICP trong trình duyệt | Có | `autoodometry.test.js` |
| FR-14 | Đo thời gian | Đồng hồ **Tay** tính khi người dùng làm thẳng trên CVAT, đồng hồ **Tool** tính khi làm trong BoxLift; dừng sau một khoảng không thao tác; kèm số vật thể mỗi bên | Có | `compare.test.js`, `session.test.js` |
| FR-15 | Box đã sửa | So box máy đề xuất với box đã lưu; coi là đã sửa khi 3D IoU < 0,9, hoặc yaw lệch > 5°, hoặc đổi nhãn. Mỗi lần lưu hoặc bỏ là một bản ghi | Có | `editlog.test.js` |
| FR-16 | Phiên và dashboard | Tạm dừng, lưu phiên, dashboard phân tích, xuất CSV và Markdown cho báo cáo | Có | `session.test.js` |
| FR-17 | Log lên Supabase | Đẩy bản ghi thao tác và tóm tắt phiên khi đã cấu hình; mất mạng thì xếp hàng rồi gửi lại; tab Log xem, tải, xoá | Có | `supalog_privacy.test.js`, `csv_zip.test.js`, `xss.test.js`, `manifest.test.js` |
| FR-18 | Song ngữ | Giao diện VI/EN, khoá chuỗi không đổi theo ngôn ngữ | Có | `i18n.test.js` |
| FR-19 | Giao diện sáng/tối | Theo chủ đề của trang | Có | `theme.test.js` |
| FR-20 | Domain CVAT riêng | Người dùng thêm domain trong trang Cài đặt, cấp quyền cho đúng domain đó | Có | không có test tự động |

## 4. Yêu cầu phi chức năng

| Nhóm | Yêu cầu | Cách đáp ứng |
|---|---|---|
| Riêng tư | Ảnh và point cloud không rời máy người dùng | Mô hình và runtime là file của extension; suy luận chạy trong trình duyệt; chỉ log thao tác (không ảnh, không điểm) đi Supabase khi có cấu hình |
| Riêng tư | Log của mỗi máy tách khỏi máy khác | Mỗi máy đăng nhập ẩn danh vào Supabase; RLS so `device_id` với `auth.uid()` trong JWT do Supabase ký, nên không giả được bằng cách tự gắn header (mục 5.7) |
| Hiệu năng | Duyệt liên tục không bị chờ | MTrans khoảng 70 ms mỗi xe trên WebGPU; một lượt `Shift+T` trên 6 camera khoảng 0,4 s cộng thời gian mô hình box (đo trên Mac, Chrome) |
| Tương thích | Chạy được khi máy không có WebGPU | Rơi về WASM một luồng; xe con khi đó dùng Frustum PointNet vì MTrans chậm trên WASM (khoảng 2 giây mỗi xe) |
| Cài đặt | Annotator cài không cần build | File zip release đã gồm đủ 5 mô hình ONNX, kiểm SHA256 |
| Dung lượng | Zip release | Khoảng 150 MB (riêng mô hình khoảng 130 MB) |
| Pháp lý | Giấy phép mô hình | Học trên dữ liệu CC BY-NC-SA nên chỉ dùng phi thương mại ([`THIRD_PARTY.md`](../extension/THIRD_PARTY.md)) |
| Chịu lỗi | Không mất thao tác khi lỗi mạng hay tải mô hình | Hàng đợi log offline; lỗi tải mô hình báo rõ nguyên nhân (thường do tải nhầm Source code zip) |
| Bảo trì | Logic tách khỏi giao diện, kiểm thử được | Phần tính toán là hàm thuần, chạy được bằng Node trong `tests/`, không cần trình duyệt |

## 5. Thiết kế

Bức tranh chung và các sơ đồ: xem [`architecture.md`](architecture.md). Mục này giải thích cách từng phần hoạt động.

### 5.1 Dựng box 3D từ khung 2D

1. Lấy các điểm LiDAR có hình chiếu rơi trong khung 2D (frustum).
2. Ước lượng mặt đất cục bộ (RANSAC trên các điểm thấp của frustum rộng hơn) và bỏ điểm mặt đất.
3. Đưa điểm và ảnh crop vào mô hình theo lớp (bảng 5.2) để ra tâm, kích thước, yaw của cả vật thể, kể cả phía bị khuất.
4. Với xe, lấy trục xe từ LiDAR (L-shape, sai số khoảng 2°), rồi mô hình ảnh chọn đầu hay đuôi: trong hai hướng dọc trục, giữ
   hướng mô hình thấy có khả năng cao hơn.
5. Nhánh hình học (xe máy, dự phòng): gom cụm Euclid trên lưới 3D, chọn cụm có phạm vi hình chiếu 2D khớp nhất với khung.

### 5.2 Chọn mô hình

| Lớp vật thể | Mô hình | Đầu vào | Cần WebGPU |
|---|---|---|---|
| Xe con | MTrans | Ảnh crop + điểm LiDAR | Có (không có thì rơi về Frustum) |
| Xe tải, buýt, xe đạp, người | Frustum PointNet (tách điểm vật thể, rồi hồi quy box) | Điểm LiDAR | Không |
| Xe máy, trường hợp dự phòng | Hình học (gom cụm) | Điểm LiDAR | Không |
| Phát hiện 2D cho `T` | YOLOX-S | Ảnh | Không (WebGPU nhanh hơn) |
| Đầu/đuôi xe | MobileNetV3 (8 bin góc quan sát) | Ảnh crop | Không |

Mô hình học trên nuScenes (và KITTI cho MTrans). Mô hình được chọn theo **lớp** vật thể; job có thể gộp nhiều lớp vào một
nhãn nên có bước ánh xạ lớp mô hình sang nhãn của job, hệ thống gợi ý theo tên nhãn rồi người dùng xác nhận và được nhớ
theo dự án.

### 5.3 Chiếu LiDAR lên camera và calib

Chuỗi biến đổi: điểm trong hệ cảm biến LiDAR, sang hệ xe, sang hệ camera, qua mô hình camera ra pixel. Mô hình camera thường
dùng Brown–Conrady, camera fisheye dùng Kannala–Brandt. Nếu camera chụp lệch thời điểm so với LiDAR, vị trí xe tại thời điểm
chụp được nội suy từ chuyển động xe quanh sweep.

Calib người dùng chỉnh là 7 độ lệch đặt lên calib gốc: pan, tilt, roll (độ), dx, dy, dz (mét) và tỉ lệ tiêu cự. Khi giải từ
cặp điểm, hệ thống tối ưu 7 độ lệch này bằng Levenberg–Marquardt với trọng số Huber để chống click sai, và kết quả hiện ngay
trên các thanh trượt.

**Chọn calib cho một task** (không theo mã task): (1) calib đã lưu cho task này trong `chrome.storage.local`; (2) khớp biểu
thức chính quy `match` của từng profile với **tên task** (không phân biệt hoa thường); (3) tên chứa `8cam`, `surround`,
`rig8` thì dùng rig 8 camera; (4) không khớp thì báo thiếu calib và người dùng chọn tay hoặc nạp `calib.json`.

### 5.4 Track 3D

Đầu vào: box ở frame đầu và số frame cần bám. Với từng frame kế tiếp:

1. Tính chuyển động xe giữa hai sweep: từ pose từng frame nếu có, không thì ICP 2D (x, y, yaw) trên cấu trúc nằm trên mặt đất.
2. Dời box theo chuyển động xe (cộng vận tốc riêng của vật nếu biết) ra dự đoán.
3. Khớp lại dự đoán với sweep mới: gom cụm điểm gần dự đoán, căn box **cùng kích thước** (vật rắn không đổi kích thước) theo
   tâm và hướng.

Sau khi đi hết đoạn: gom quan sát thành một vật thể theo toạ độ thế giới, chốt một kích thước cho cả ID, xác định đứng im hay
di chuyển, sinh box cho từng frame, đánh dấu frame vật bị che, và chọn vài keyframe để lưu thành **track CVAT** (nội suy
tuyến tính giữa hai keyframe, giữ nguyên sau keyframe cuối, `outside = true` thì ẩn từ frame đó). Thao tác tay của người dùng
luôn được ưu tiên: keyframe tay không bị tính lại ghi đè.

Màu trên thanh frame: đỏ là keyframe của người dùng, xanh dương là đoạn giữa hai keyframe đỏ, xanh lá là đoạn sau keyframe
cuối do 3D Track tính.

### 5.5 Tích hợp CVAT

| Hướng | Cách | Lý do |
|---|---|---|
| Lấy point cloud và ảnh | Cầu nối chạy trong trang CVAT, đăng ký như plugin giao diện chính thức của CVAT, trả lại frame CVAT đã tải | Không tải lần hai, không cần mật khẩu |
| Lưu và đọc box | REST `/api/...` cùng origin với trang, bằng phiên đăng nhập của người dùng | Không phát sinh quyền mới |
| Đếm vật thể của job | Lấy từ thống kê của CVAT, kể cả box chưa lưu | Bảng Làm tay vs Dùng tool đúng với trạng thái đang xem |

Khi cầu nối chưa sẵn sàng hoặc job khác đang mở, extension rơi về tải qua REST.

### 5.6 Giao thức giữa các thành phần

| Giữa | Kênh | Thông điệp |
|---|---|---|
| Content script và cầu nối trong trang | `window.postMessage`, chỉ nhận cùng cửa sổ và cùng origin | `ping`, `cloud` (point cloud), `images` (ảnh camera), `count` (số vật thể) |
| Content script và Supabase | HTTPS tới `/auth/v1` và `/rest/v1` | Đăng nhập ẩn danh một lần, gia hạn token khi sắp hết hạn; mọi ghi và đọc mang JWT của máy |
| Content script và service worker | `chrome.runtime.sendMessage` | `listCalibs`, `getCalib`, `getDbConfig`; chỉ cho tên calib hợp lệ |
| Content script và iframe mô hình | `MessageChannel` trao một lần ở thông điệp đầu | `size` (nạp YOLOX), phát hiện 2D, `heading`, `frustum`, `mtrans`; mô hình nạp ở yêu cầu đầu tiên, chạy tuần tự từng yêu cầu |

### 5.7 Mô hình dữ liệu (Supabase)

| Bảng | Khoá | Nội dung chính | Quyền |
|---|---|---|---|
| `edit_logs` | `id` | Một bản ghi mỗi lần lưu hoặc bỏ box: job, frame, camera, `action` (save/skip), `how` (tay/T/lan/learned), `model`, nhãn, độ tin cậy, số điểm, `edited`, `iou`, `dyaw_deg`, `label_changed`, `time_spent_seconds`, `track_id`, `n_adjust` | RLS: `device_id = auth.uid()`, đủ SELECT/INSERT/UPDATE/DELETE |
| `annotation_sessions` | `session_id` | Tóm tắt phiên: trạng thái, thời lượng, số box, số box tay và tool, giây trung bình tay và tool, hệ số tăng tốc, IoU và yaw trung bình, tỉ lệ sửa, thống kê theo lớp, giờ theo frame. Không gửi tên task | RLS: `device_id = auth.uid()` |
| `task_poses` | `(task_name, owner_device_id)` | Quỹ đạo xe (KISS-ICP) của một task; hai người cùng tên task không đè nhau | RLS: `owner_device_id = auth.uid()`, không có quyền xoá |

**Danh tính.** Extension đăng nhập ẩn danh (Supabase Anonymous Sign-ins), lưu token trong `chrome.storage.local` và tự gia hạn.
Khi gửi, mọi dòng đều bị ghi đè chủ bằng `auth.uid()` của máy (kể cả log xếp hàng lúc offline), và RLS kiểm lại điều đó. Chỉ có
anon key mà không có JWT thì không đọc hay ghi được bảng nào. Dòng cũ mang `device_id` ngẫu nhiên từ trước không còn hiện ra trên
extension; quản trị viên xem toàn bộ qua Supabase Studio hoặc service-role key. Khoá cấu hình nằm ở `config/database.json` (không
commit). Cài đặt phía Supabase: bật "Allow anonymous sign-ins" và chạy `db/migrations/2026-10-auth.sql`.

Log chỉ chứa số đo và định danh vô nghĩa: không tên file, tên task, scene, không box, không pose, không calib (có test
`supalog_privacy.test.js` kiểm điều này).

## 6. Quyết định thiết kế và đánh đổi

| Quyết định | Phương án khác | Lý do chọn |
|---|---|---|
| Chạy mô hình trong trình duyệt (ONNX Runtime Web) | Server GPU riêng | Giữ dữ liệu trên máy, không cần hạ tầng; đổi lại mô hình phải nhẹ và xe con cần WebGPU |
| Extension chạy trên CVAT hiện có | Tool gán nhãn riêng | Giữ nguyên quy trình và định dạng lưu của đội; không phải di chuyển dữ liệu |
| MTrans cho xe con, Frustum PointNet cho lớp khác | Một mô hình cho mọi lớp | Mỗi lớp dùng mô hình tốt nhất đã đo được; xem bảng độ chính xác ở README |
| Học tiếp MTrans trên nuScenes | Dùng nguyên bản học KITTI | MTrans chỉ học KITTI đạt 32,9% IoU 3D ≥ 0,7 trên nuScenes, học tiếp lên 78,8% (nhật ký KQ-3, KQ-4 trong `RESEARCH.md`) |
| Tính toán là hàm thuần, tách khỏi giao diện | Gộp trong giao diện | Kiểm thử bằng Node, dùng chung code giữa extension và công cụ đo ngoài |
| Chọn calib theo tên task | Theo mã task, hoặc tự dò từ dữ liệu | Mã task đổi sau khi reset Docker; tên task do người dùng đặt nên ổn định. Hạn chế: dữ liệu mới phải nạp `calib.json` một lần |
| Log lên Supabase, tuỳ chọn | Chỉ lưu cục bộ | Cho phép cả nhóm gộp số liệu cho bảng Làm tay vs Dùng tool; tắt được khi không cần |
| Danh tính bằng đăng nhập ẩn danh (JWT) | Header `x-device-id` tự khai; đăng nhập email | Header giả được, cả nhóm dùng chung anon key; email thì bắt annotator tạo tài khoản. Đăng nhập ẩn danh không cần thao tác nào mà vẫn có danh tính do Supabase ký. Đổi lại: cần bật tuỳ chọn ở Supabase, và mất danh tính nếu xoá dữ liệu extension |
| Mô hình ONNX ngoài git, đóng gói trong zip release | Commit mô hình | Mô hình khoảng 130 MB; `.gitignore` loại `.onnx`, zip release bắt buộc có đủ để annotator dùng ngay |

## 7. Kiểm thử và tiêu chí chấp nhận

### 7.1 Kiểm thử tự động

Chạy toàn bộ: `for t in tests/*.test.js; do node $t; done` (Node 18+). Mỗi chức năng ở mục 3 có file test tương ứng; chi tiết
chiến lược và kết quả kiểm thử nằm ở tài liệu kiểm thử riêng.

### 7.2 Tiêu chí chấp nhận

| Chỉ tiêu | Ngưỡng | Kết quả hiện có | Nguồn |
|---|---|---|---|
| Xe con, IoU 3D ≥ 0,7 (827 box, nuScenes 0103 và 0916) | Cao hơn bản Frustum (46,4%) | **73,5%** | README, KQ-5 |
| Xe con, IoU 3D ≥ 0,5 | | **92,3%** | README |
| Xe con, lệch tâm p50 | | **0,18 m** | README |
| Xe con, hướng 360° ≤ 10° | | **82,8%** | README |
| Tốc độ MTrans | Không gây chờ khi duyệt | khoảng 70 ms mỗi xe (WebGPU) | README |
| Thời gian mỗi cuboid, Làm tay vs Dùng tool | Giảm so với làm tay | **Chưa đo xong**, điền sau khi có báo cáo | `tools/public/time_study.py`, dashboard phiên |
| Số lần phải căn chỉnh lại, tỉ lệ box phải sửa | Thấp hơn làm tay | **Chưa đo xong** | Log `edit_logs` |

Số đo độ chính xác lấy trên 2 cảnh nuScenes không dùng để học; mô hình được chọn trên chính 2 cảnh đo nên số có thể hơi lạc quan.

## 8. Giới hạn hiện tại

- Chỉ đo trên dữ liệu công khai (nuScenes, KITTI); chưa có đáp án cho camera fisheye và LiDAR dày.
- MTrans chỉ học xe con và cần WebGPU.
- Calib phải chuẩn (khoảng ≤ 0,5° và 10 cm); mô hình học trên calib đúng.
- Vật xa, bị che nhiều hoặc rất ít điểm LiDAR cho box kém tin cậy; extension cảnh báo "Ít điểm LiDAR".
- Box lan qua frame kiểu **Shape** là shape riêng từng frame nên mất ID; dùng **Track** để giữ ID.
- Dữ liệu ngoài bộ calib có sẵn phải nạp `calib.json` một lần cho mỗi task.

## 9. Bảo mật

### 9.1 Đã có

| Biện pháp | Chi tiết |
|---|---|
| Không đưa dữ liệu thô ra ngoài | Mô hình AI chạy trong trình duyệt; cookie và token phiên CVAT chỉ gửi tới `origin + '/api'` của chính trang |
| Bảo vệ file cấu hình DB | `config/database.json` không web-accessible; content script phải hỏi service worker; tên calib được lọc bằng `^[\w.-]+$` chống path traversal |
| Cầu nối an toàn | Cầu nối trong trang chỉ nhận thông điệp cùng cửa sổ và chỉ trả dữ liệu của đúng job đang mở |
| Script dev | `cvat_upload.py` từ chối server ngoài localhost nếu không bật `--any-host`; `mock_cvat.py` chuẩn hoá đường dẫn |
| Không lộ khoá | Theo rà soát, lịch sử Git và zip release không chứa `database.json` thật |

### 9.2 Rà soát 16/10/2026 và kết quả xử lý

| Mức | Rủi ro | Xử lý | Kiểm thử |
|---|---|---|---|
| Trung bình | RLS tin header `x-device-id` tự khai, cả nhóm dùng chung anon key: ai biết `device_id` của người khác có thể đọc, sửa, xoá phiên của họ | Đã sửa: đăng nhập ẩn danh, RLS theo `auth.uid()`, client ghi đè chủ mọi dòng, migration `2026-10-auth.sql` | `supalog_privacy.test.js` |
| Trung bình | `task_poses` cho anon ghi và cập nhật tự do | Đã sửa: khoá `(task_name, owner_device_id)`, RLS theo chủ, không có DELETE | `supalog_privacy.test.js` |
| Trung bình | `innerHTML` chèn tên lớp, camera, job, `how`, nhãn không escape (`session-popup.js`, `logtab.js`, `lab.js`, `options.js`) | Đã sửa: `esc()` cho mọi chuỗi động; `options.js` đổi sang `textContent` | `xss.test.js` |
| Trung bình | `web_accessible_resources` cho `<all_urls>` truy cập `detector.html`, `logtab.html`, mô hình, calib, runtime, script | Đã thu hẹp còn 4 mục trang CVAT thực sự nạp (`ui/detector.html`, `ui/logtab.html`, `ui/session-popup.css`, `assets/Logo/*`); `detector.js` chỉ trao cổng cho trang có origin là CVAT (3 domain mặc định và domain người dùng đã thêm). `matches` vẫn là `<all_urls>` vì tính năng thêm domain CVAT riêng cần nó | `manifest.test.js` |
| Thấp | CSV có thể chứa công thức (`=`, `+`, `-`, `@`); bản xuất theo phiên chưa quote | Đã sửa: một hàm `csvCell` dùng chung cho cả 3 chỗ xuất | `csv_zip.test.js` |
| Thấp | Giải nén ZIP không giới hạn bộ nhớ | Đã sửa: tối đa 256 MB mỗi mục, đọc theo luồng và dừng khi vượt | `csv_zip.test.js` |
| Thấp | `*.zip` ở thư mục gốc chưa nằm trong `.gitignore` | Đã sửa: thêm `*.zip` | (kiểm bằng `git check-ignore`) |

Còn lại sau các bản sửa: trang bất kỳ vẫn dò được sự có mặt của 4 file trên (rò rỉ thông tin nhẹ, không lộ dữ liệu); mô hình và calib
không còn đọc được từ ngoài. Các thay đổi trên được kiểm bằng test tự động, chưa kiểm trong Chrome thật với CVAT, nên cần thử một
lượt (iframe detector, mở tab Log, đẩy log lên Supabase) trước khi phát hành.

## 10. Truy vết yêu cầu

| Vấn đề | Chức năng giải quyết | Quyết định liên quan |
|---|---|---|
| P-014: đối chiếu ảnh 2D với điểm 3D bằng mắt, hơn 30 phút mỗi frame | FR-01, FR-02, FR-03 (thấy ngay điểm chiếu), FR-04 đến FR-10 (dựng sẵn box), FR-12 (Track) | Xem so-quyet-dinh.md (tài liệu nội bộ của nhóm) |
| Cần số liệu chứng minh hiệu quả | FR-14 đến FR-17 | Mục 1.2 G1, G2 |
