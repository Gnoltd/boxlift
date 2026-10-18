# Phân công calib-overlay → demo 25/10/2026

**Tool làm gì:** extension Chrome chạy trên CVAT. Người gán nhãn kéo khung 2D trên ảnh (hoặc bấm T để máy tự tìm xe),
tool tự dựng hộp 3D từ điểm LiDAR. Người chỉ cần duyệt và sửa. Mục tiêu đề bài: **giảm thời gian gán mỗi cuboid**, đo
bằng thời gian / cuboid, IoU 3D, sai số hướng.

**Tính từ 12/10:** hôm nay chốt plan · **13/10 họp phân việc** (điền cột Người) · 25/10 demo.
Nghiên cứu, DOI, nhật ký thử nghiệm cho report: [`RESEARCH.md`](RESEARCH.md)

---

## Hiện tại đã có gì (bản 0.19.0)

| Đã có | Chưa có / đang lỗi |
|---|---|
| Kéo khung 2D → tự dựng hộp 3D | Chưa đo thời gian với người thật (chỉ số chính của đề bài) |
| T / Shift+T: máy tự tìm xe trên 1 / mọi camera (YOLOX) | Nhãn tự động đoán theo tên, người không chọn được |
| Hộp 3D: xe con dùng MTrans, xe tải / buýt / người dùng Frustum PointNet, xe máy dùng hình học | Không thấy độ tin cậy trên từng box, ngưỡng cố định |
| Lan box sang frame kế, sửa box, lưu vào CVAT | Bỏ sót xe rõ trên ảnh; 2 xe đỗ sát nhau bị gộp thành 1 |
| Độ chính xác xe con: IoU 3D ≥ 0,7 đạt 73,5% | Chỉ lưu được shape, lan qua frame bị mất ID (chưa có track) |
| Code đã commit ở nhánh `chore/import-extension` | Không chuyển frame được trong cửa sổ extension |
| | Calib: 11 file theo từng cảnh, dữ liệu mới phải sinh thêm file |

## Mốc

| Ngày | Mốc | Nghĩa là |
|---|---|---|
| 13/10 | Họp phân việc | Mỗi người nhận vai trò, tự ước lại giờ |
| 15/10 | Bản đo lần 1 (`v0.19.1`) | Có ghi box bị sửa, tải model bằng script |
| 16–17/10 | **Đo lần 1** | Cả nhóm đo tay vs tool |
| 19/10 | **Khoá code** (`v1.0.0-rc.1`) | Sau ngày này chỉ sửa lỗi; việc mới làm ở nhánh thử nghiệm |
| 20–22/10 | **Đo lần 2** | Đo trên bản đã khoá |
| 24/10 | Phát hành `v1.0.0`, diễn tập | |
| 25/10 | **Demo** | |

## Bảng phân công

| # | Vai trò | Người | Tính năng phụ trách | Giờ |
|---|---|---|---|---|
| 1 | Lead, tích hợp | | Đưa code vào repo · Tải model · Review, phát hành · Calib từ 1 file mẫu | ~39 |
| 2 | Dev, lưu dữ liệu | | Lưu Shape / Track · Đồng bộ frame với CVAT · Ghi box bị sửa · Đổi shape cũ ↔ track | ~41 |
| 3 | **Dev UI/UX** | | Thanh chuyển frame · Độ tin cậy trên box · Giao diện duyệt · Phím tắt · Màn Cài đặt · Thử với người dùng · Giao diện áp dụng calib | ~37 |
| 4 | Dev, nhãn và phát hiện xe | | Ánh xạ nhãn · Ngưỡng tin cậy · Debug "vì sao không có box" · Bộ ca lỗi · Thử bắt xe nhỏ / xa · Thử tách xe đỗ sát nhau · Đáp án calib | ~35 |
| 5 | Đo và tài liệu | | Đo thời gian tay vs tool · Hướng dẫn cài · Demo, slide, report | ~42 |

Mỗi người **làm trọn tính năng của mình**: code, test, ghi vào hướng dẫn. Cả 5 người đều tham gia đo (khoảng 4 giờ / người).

**UI/UX làm việc với các vai trò khác thế nào:** người giữ logic (2, 4, Lead) chốt dữ liệu và hàm cho phần giao diện
trong **ngày đầu** của tính năng. Dev UI/UX dựng giao diện trên đó, không sửa logic. Các cặp:

| Giao diện (vai trò 3) | Logic phía sau |
|---|---|
| 3.1 Thanh chuyển frame | 2.2 Đồng bộ frame với CVAT |
| 3.2 Độ tin cậy trên box, 3.5 Màn Cài đặt | 4.1 Ánh xạ nhãn, 4.2 Ngưỡng tin cậy, 2.1 Chế độ lưu |
| 3.3 Giao diện duyệt | 2.3 Ghi box bị sửa, hàng đợi lưu |
| 3.7 Giao diện áp dụng calib | 1.4 Calib từ 1 file mẫu |

---

## 1. Lead, tích hợp

### 1.1 Đưa code vào repo · hạn 13/10
- **Dùng để:** cả nhóm làm chung một chỗ, mọi thay đổi đi qua review.
- **Hiện tại:** code 0.19.0 nằm ở nhánh `chore/import-extension`, chưa có nhánh `dev`.
- **Cần làm:** tạo `dev`, khoá `main` / `dev` (bắt buộc PR + 1 approve), bỏ file model khỏi git, merge, gắn tag `v0.19.0`.
- **Xong khi:** người khác clone về, chạy test qua hết.

### 1.2 Tải model · hạn 15/10
- **Dùng để:** model 123 MB không để trong git; người dùng cài nhẹ, máy nào cũng lấy đúng bản.
- **Hiện tại:** model nằm sẵn trong `extension/models/`, cả extension nặng 149 MB.
- **Cần làm:** đưa model lên nơi đã chốt; script tải về và kiểm tra file không hỏng; ghi cách kiểm máy có WebGPU
  (không có thì tool tự dùng Frustum PointNet thay MTrans).
- **Xong khi:** máy sạch chạy script là extension chạy đủ model.

### 1.3 Review và phát hành · 15/10, 19/10, 24/10
- **Dùng để:** giữ bản đo và bản demo luôn chạy được.
- **Cần làm:** review mọi PR; ra bản đo lần 1 (15/10); khoá code (19/10); phát hành `v1.0.0` (24/10).

### 1.4 Calib từ 1 file mẫu · thử nghiệm 20–23/10, vào bản sau demo
- **Dùng để:** calib là thông số cho biết camera và LiDAR đặt ở đâu so với nhau; sai thì điểm LiDAR chiếu lệch khỏi xe.
  Thay vì mỗi cảnh một file, chỉ giữ **1 file mẫu**, tool tự tinh chỉnh cho từng task.
- **Hiện tại:** 11 file calib + `index.json`, chọn theo tên task. Đã có bộ giải chỉnh calib từ các cặp điểm click tay
  (`pairs.js`).
- **Cần làm:**
  1. Chốt cấu trúc `template.json` (giữ cấu trúc file hiện tại), kiểm tra file hợp lệ.
  2. Ghép camera của job với camera trong file mẫu (`image_1` ↔ `CAM_P_F`…).
  3. Tự tinh chỉnh: căn cạnh trong ảnh với chỗ độ sâu LiDAR đổi đột ngột, trên nhiều frame (cách của Levinson & Thrun,
     xem RESEARCH.md R3).
  4. Trả về sai số trước / sau cho từng camera để 3.7 hiển thị.
- **Xong khi:** sai số chiếu giảm so với file mẫu, đo trên đáp án của 4.7; kết quả ghi vào RESEARCH.md.
- Nếu đo lần 1 cho thấy MTrans làm người đo phải chờ: việc này dời sang sau demo, Lead làm nhẹ mô hình trước.

## 2. Dev, lưu dữ liệu

### 2.1 Lưu Shape / Track · hạn 17/10 (script đo đếm track: 19/10)
- **Dùng để:** hai bài toán khác nhau.
  - **Shape:** bài toán detection. Mỗi frame gán độc lập.
  - **Track:** bài toán tracking. Một xe giữ **một ID** qua mọi frame.
- **Hiện tại:** chỉ lưu shape. Box lan sang frame kế thành box mới, mất ID.
- **Cần làm:**
  1. Lưu lựa chọn "Chế độ lưu: Shape / Track" theo task (nút chọn nằm ở 3.5).
  2. Chế độ Track: box mới tạo track; lan sang frame kế thì thêm vào đúng track đó; xoá thì đánh dấu "ra khỏi khung".
  3. Script đo thời gian đếm được cả cuboid nằm trong track.
  4. Test tự động cho phần lưu track.
- **Xong khi:** lan 1 xe qua 5 frame → CVAT hiện 1 track cùng ID; chế độ Shape vẫn như cũ.

### 2.2 Đồng bộ frame với CVAT · hạn 18/10
- **Dùng để:** phần chạy phía sau thanh chuyển frame (3.1): đổi frame trong extension thì CVAT đổi theo và ngược lại.
- **Hiện tại:** chỉ có "Frame kế + lan", hoạt động bằng cách bấm hộ nút frame kế của CVAT.
- **Cần làm:** hàm tiến / lùi / nhảy tới frame N qua player của CVAT; theo dõi khi người đổi frame ở CVAT; chỉ tải point
  cloud + ảnh khi người thả thanh kéo, tải trước frame kế; đổi frame khi còn box chưa lưu thì không mất box.
- **Xong khi:** tiến / lùi / nhảy 10 frame, hai bên cùng frame, không mất box.

### 2.3 Ghi box bị sửa · hạn 15/10 (phải có trước đo lần 1)
- **Dùng để:** biết bao nhiêu % box máy đề xuất người phải sửa. Đây là số chất lượng cho report.
- **Hiện tại:** chưa có.
- **Cần làm:** lúc lưu, so box máy đề xuất với box được lưu, lệch quá ngưỡng thì tính "đã sửa". Ghi kèm cách tạo (vẽ tay
  hay T), mô hình nào dựng, độ tin cậy. Báo cáo đo có cột "% box phải sửa".
- **Xong khi:** thử 10 box, sửa 3 → báo đúng 3 / 10.

### 2.4 Đổi shape cũ ↔ track · 20–22/10, nếu họp chốt cần
- **Dùng để:** dữ liệu đã gán bằng shape chuyển sang track được (và ngược lại) khi đổi bài toán.
- **Cần làm:** gom shape cùng xe qua các frame thành track; có xem trước, chỉ chạy khi người bấm.

## 3. Dev UI/UX

Phụ trách **mọi thứ người dùng nhìn thấy và bấm vào** trong cửa sổ extension. Mục tiêu: người đo không phải dev dùng
được ngay, ít bấm, không phải đoán tool đang làm gì.

### 3.1 Thanh chuyển frame · hạn 18/10
- **Dùng để:** đổi frame ngay trong cửa sổ extension, thao tác như CVAT, không phải đóng cửa sổ.
- **Hiện tại:** chỉ có nút "Frame kế + lan". Không lùi, không thanh kéo, không nhập số frame.
- **Cần làm:** thanh `⏮ ◀ [thanh kéo] ▶ ⏭` + ô nhập số frame + `frame 29 / N` dưới thanh công cụ; nối với 2.2.
- **Xong khi:** dùng được hoàn toàn bằng chuột và bằng phím.

### 3.2 Độ tin cậy trên từng box · hạn 16/10
- **Dùng để:** người duyệt nhìn là biết box nào máy chắc, box nào phải kiểm kỹ, nên duyệt nhanh hơn.
- **Hiện tại:** % chỉ hiện ở panel bên phải cho box đang chọn.
- **Cần làm:** ghi `car 77%` ngay trên box ở ảnh, màu theo mức (cao / vừa / thấp). Cờ "kiểm tra" khi box có ít điểm
  LiDAR hoặc máy không chắc đâu là đầu xe.
- **Xong khi:** mọi box tự động trên 8 camera đều có nhãn đọc được, không che nhau.

### 3.3 Giao diện duyệt · hạn 19/10
- **Dùng để:** duyệt hàng loạt box nhanh, luôn biết box đã lưu hay chưa.
- **Hiện tại:** trạng thái lưu chỉ báo bằng thông báo chớp qua; panel bên phải dài, nhiều nút.
- **Cần làm:** thanh tiến độ khi duyệt ("3 / 12 box"); trạng thái lưu cố định (chờ gửi / lỗi / đã lưu); sắp xếp lại
  panel: nút hay dùng lên trên, nút ít dùng gom lại.

### 3.4 Phím tắt · hạn 17/10
- **Dùng để:** người quen CVAT không bị bấm nhầm; thao tác nhanh bằng bàn phím.
- **Hiện tại:** phím D / F đang đổi camera, trùng phím đổi frame của CVAT; còn phím khác chưa kiểm.
- **Cần làm:** so toàn bộ phím của extension với CVAT, sửa chỗ trùng (D / F theo quyết định họp 13/10); bảng phím tắt mở
  bằng `?`.

### 3.5 Màn Cài đặt · hạn 18/10
- **Dùng để:** một chỗ duy nhất để cấu hình: ánh xạ nhãn (4.1), ngưỡng tin cậy (4.2), chế độ lưu Shape / Track (2.1).
- **Hiện tại:** cài đặt rải rác (ô "Tự động nhận", ô "Tự lưu"), không có chỗ chọn nhãn hay ngưỡng.
- **Cần làm:** màn Cài đặt có 3 phần trên; bảng ánh xạ có dropdown nhãn của job; thanh kéo ngưỡng từng lớp, kéo là thấy
  số box đổi ngay; nút xuất / nạp cấu hình.
- **Xong khi:** người mới cấu hình xong job 18126 trong dưới 2 phút, không cần hỏi.

### 3.6 Thử với người dùng · 17/10, sửa trước 19/10
- **Dùng để:** tìm chỗ khó dùng trước khi khoá code.
- **Cần làm:** trong đo lần 1, ghi lại chỗ người đo dừng lại, bấm nhầm, phải hỏi; xếp theo mức nặng; sửa những chỗ nặng
  nhất trước 19/10, còn lại ghi vào backlog.

### 3.7 Giao diện áp dụng calib · 21–23/10, thử nghiệm
- **Dùng để:** người xem calib tự tinh chỉnh (1.4) có tốt hơn không rồi mới quyết định dùng.
- **Cần làm:** bảng từng camera: sai số trước / sau, trạng thái; nút **Áp dụng** / **Bỏ** / quay về file mẫu.

## 4. Dev, nhãn và phát hiện xe

### 4.1 Ánh xạ nhãn · hạn 17/10
- **Dùng để:** người tự chọn lớp nào của mô hình đổ vào nhãn nào của job. Ví dụ `car` + `truck` + `bus` → `vehicles`.
  Không để tool tự đoán theo tên nhãn.
- **Hiện tại:** tool đoán bằng danh sách từ đồng nghĩa. Job chỉ có nhãn `vehicles` thì `truck` / `bus` bị xám, không tự
  động được. MTrans được chọn theo tên nhãn CVAT, nên đổi tên nhãn là đổi mô hình.
- **Cần làm:** lưu ánh xạ theo project (màn hình ở 3.5); lần đầu tool gợi ý, người phải xác nhận, chưa xác nhận thì T báo
  "chưa cấu hình ánh xạ nhãn"; chọn mô hình 3D theo lớp mô hình, không theo tên nhãn; xuất / nạp JSON.
- **Xong khi:** trên job 18126, car / truck / bus đều tự động vào `vehicles`; có test.

### 4.2 Ngưỡng tin cậy · hạn 18/10
- **Dùng để:** chỉ đề xuất box đủ chắc. Kéo ngưỡng để cân giữa bỏ sót xe và box rác.
- **Hiện tại:** ngưỡng cố định 0,3 trong code.
- **Cần làm:** ngưỡng riêng cho từng lớp và số điểm LiDAR tối thiểu (thanh kéo ở 3.5); máy tìm xe chạy 1 lần, kéo ngưỡng
  thì chỉ lọc lại; "Lưu tất cả" chỉ lưu box trên ngưỡng; ghi độ tin cậy vào log đo để chọn ngưỡng mặc định bằng số liệu.
- **Xong khi:** đổi ngưỡng thì số box đổi ngay, không chạy lại mô hình; có test.

### 4.3 Debug "vì sao không có box" · hạn 17/10
- **Dùng để:** biết xe bị sót rơi ở bước nào để sửa đúng chỗ.
- **Hiện tại:** không biết. Có thể do ngưỡng, xe quá nhỏ, bị loại trùng, hay ít điểm LiDAR.
- **Cần làm:** chế độ debug vẽ mọi box thô kèm lý do bị loại.
- **Xong khi:** trên frame 29 job 18126, mọi xe bị sót đều thấy lý do.

### 4.4 Bộ ca lỗi · hạn 17/10
- **Dùng để:** một bộ chung để đo trước / sau cho mọi thay đổi về phát hiện xe (4.5, 4.6).
- **Cần làm:** ít nhất 20 ca, chia 2 loại: **bỏ sót** và **2 xe thành 1**. Mỗi ca có link job + frame, camera, lý do (từ
  4.3). Ghi vào `tools/public/error-cases.md`.

### 4.5 Thử nghiệm: bắt xe nhỏ / xa · 20–21/10
- **Dùng để:** giảm số xe bị bỏ sót.
- **Cần làm:** chạy máy tìm xe trên từng ô nhỏ của ảnh rồi gộp lại (SAHI, xem RESEARCH.md R4); so với cách hạ ngưỡng. Đo
  trên bộ ca lỗi: bắt thêm được bao nhiêu xe, sai thêm bao nhiêu, chậm thêm bao lâu.

### 4.6 Thử nghiệm: xe đỗ sát nhau bị gộp · 22–23/10
- **Dùng để:** 2 xe đỗ sát, chỉ thấy đầu / đuôi, phải ra 2 hộp chứ không phải 1.
- **Cần làm:** box `car` dài hoặc rộng bất thường thì gắn cờ "có thể 2 xe"; tách điểm LiDAR thành cụm theo mặt đất
  (DBSCAN, xem RESEARCH.md R5), 2 cụm rõ thì ra 2 box; xem lại bước loại box trùng.
- **Xong khi:** đo trên bộ ca lỗi, độ chính xác trên nuScenes không giảm; ghi vào RESEARCH.md.

### 4.7 Đáp án calib · 20/10
- **Dùng để:** có số liệu chứng minh calib tự tinh chỉnh (1.4) tốt hơn hay không.
- **Cần làm:** click tay 20 cặp điểm LiDAR – ảnh trên job 18126, rải đều các camera; đo sai số với file mẫu.

## 5. Đo và tài liệu

### 5.1 Đo thời gian tay vs tool
- **Dùng để:** ra **chỉ số chính của đề bài**: dùng tool thì mỗi cuboid nhanh hơn bao nhiêu, chất lượng ra sao.
- **Hiện tại:** đã có script bấm giờ `time_study.py`, chưa đo người thật.
- **Cần làm:**

  | Ngày | Việc |
  |---|---|
  | 13/10 | Chốt luật gán (P-011, P-013), chốt chỉ đo lớp `car` |
  | 14/10 | Thiết kế cách đo (phụ lục), chuẩn bị dữ liệu, tạo job cho từng người đo |
  | 15/10 | Đo thử 1 người |
  | 16–17/10 | **Đo lần 1** |
  | 20–22/10 | **Đo lần 2** |
  | 23/10 | Bảng kết quả: giây / cuboid, IoU 3D, sai số hướng, % box phải sửa |

### 5.2 Hướng dẫn cài và dùng · hạn 14/10, cập nhật 19/10
- **Dùng để:** người không phải dev tự cài và dùng được, để đo được.
- **Cần làm:** từng bước cài CVAT local, extension, tải model, mở job, vẽ → duyệt → lưu, lỗi hay gặp. Ngày 19/10 thêm
  ánh xạ nhãn, ngưỡng, chế độ lưu.
- **Xong khi:** một người chưa cài lần nào làm theo được mà không phải hỏi.

### 5.3 Demo, slide, report · hạn 24/10
- **Cần làm:** kịch bản demo 5–7 phút (vấn đề → chạy thật → bảng kết quả → giới hạn), có video dự phòng; phần "nghiên
  cứu liên quan" cho report lấy từ RESEARCH.md; cập nhật README và nhật ký tuần.

---

## Lịch cả nhóm

| Ngày | 1 Lead | 2 Lưu dữ liệu | 3 UI/UX | 4 Nhãn, phát hiện | 5 Đo, tài liệu |
|---|---|---|---|---|---|
| T2 12/10 | Chốt plan | | | | |
| T3 13/10 | **Họp phân việc**; 1.1 | 2.3 | 3.4 | 4.1 | 5.1 luật gán; 5.2 |
| T4 14/10 | 1.2 | 2.3 | 3.4; 3.2 | 4.1 | 5.1 thiết kế, dữ liệu; 5.2 xong |
| T5 15/10 | **Bản đo lần 1** | 2.3 xong; 2.1 | 3.2 | 4.1, 4.3 | Đo thử |
| T6 16/10 | **Đo lần 1** | 2.1 | 3.2 xong; 3.5 | 4.3, 4.4 | **Đo lần 1** |
| T7 17/10 | **Đo lần 1**; chọn 1.4 hay làm nhẹ mô hình | 2.1 xong; 2.2 | 3.4 xong; 3.6 (quan sát người đo) | 4.1, 4.3, 4.4 xong; 4.2 | **Đo lần 1**; tổng hợp |
| CN 18/10 | Bù việc trễ | 2.2 xong | 3.1, 3.5 xong | 4.2 xong | |
| T2 19/10 | **Khoá code** | Script đo đếm track | 3.3 xong; sửa theo 3.6 | Sửa lỗi | 5.2 cập nhật |
| T3 20/10 | 1.4 | Sửa lỗi; 2.4 | Sửa lỗi | 4.5; 4.7 | **Đo lần 2** |
| T4 21/10 | 1.4 | 2.4 | 3.7 | 4.5 xong | **Đo lần 2**; 5.3 |
| T5 22/10 | 1.4 | 2.4 xong | 3.7 | 4.6 | **Đo lần 2**; 5.3 |
| T6 23/10 | 1.4 xong; review | | 3.7 xong | 4.6 xong | Bảng kết quả; 5.3 |
| T7 24/10 | **Phát hành v1.0.0** | Diễn tập | Diễn tập | Diễn tập | 5.3 xong; diễn tập |
| CN 25/10 | **Demo** | | | | |

## Quy tắc chung

1. Mỗi tính năng: 1 issue, 1 nhánh, 1 PR vào `dev`. **Không review PR của chính mình**; Lead + 1 người review.
2. PR chỉ merge khi đạt "Xong khi" và test qua: `for t in tests/*.test.js; do node $t; done`.
3. Tính năng có cả giao diện và logic: người giữ logic chốt dữ liệu / hàm trong ngày đầu, UI/UX dựng trên đó.
4. Sau **khoá code 19/10** chỉ nhận sửa lỗi. Thử nghiệm (1.4, 3.7, 4.5, 4.6) làm ở nhánh `exp/*`, **không vào bản demo**.
   Đạt tiêu chí thì đưa vào bản sau demo.
5. Mọi thử nghiệm ghi vào nhật ký trong RESEARCH.md, **kể cả khi không thành công**.
6. Họp nhanh 15 phút mỗi tối: xong gì, làm gì tiếp, vướng gì. Trễ quá 1 ngày thì báo để chuyển bớt việc, không bỏ bước test.

## Cần chốt ở họp 13/10

1. Ai giữ vai trò nào.
2. Lưu model 123 MB ở đâu: GitHub Release, Drive hay Git LFS (1.2).
3. Cảnh đo: nuScenes 0916 hay 0103 (5.1).
4. Lưu cờ "box đã sửa" ở đâu: thuộc tính shape trong CVAT hay file log (2.3).
5. Project nào dùng Shape, project nào dùng Track; có cần đổi shape cũ sang track không (2.1, 2.4).
6. Phím D / F dùng để chuyển frame (như CVAT) hay giữ để đổi camera (3.4).
7. File calib mẫu lấy ở đâu; tên camera dữ liệu thật có cố định không (1.4).
8. Có được dùng ảnh từ CVAT thật (job 18126…) để thử nghiệm không (4.4–4.7).

---

## Phụ lục: cách đo tay vs tool

- 4 người đo, 2 tập frame cùng cảnh, số xe tương đương. Mỗi người làm 1 tập bằng tay và tập kia bằng tool, thứ tự
  đổi chéo, để không lệch do quen cảnh hay do tập dễ / khó:

  | Người đo | Phiên 1 | Phiên 2 |
  |---|---|---|
  | 1 | Tay · tập A | Tool · tập B |
  | 2 | Tool · tập B | Tay · tập A |
  | 3 | Tay · tập B | Tool · tập A |
  | 4 | Tool · tập A | Tay · tập B |

- Trước khi đo: làm quen tool 15 phút trên cảnh khác, không bấm giờ. Nghỉ 10 phút giữa 2 phiên.
- Lệnh: `time_study.py run --mode manual|tool --job <job> --frames <tập> --scene <cảnh> --note "<người, phiên>"`.
- Người viết tool chỉ đo phần tool, ghi riêng, không gộp vào bảng chính.
- Lần 2 dùng tập C, D mới, cùng cách bố trí.
