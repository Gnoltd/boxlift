# BoxLift: sơ đồ kiến trúc

BoxLift là extension Chrome (Manifest V3) chạy trên job 3D của CVAT. Toàn bộ tính toán nằm trong trình duyệt của annotator;
dữ liệu chỉ đi giữa trang CVAT và extension. Chỉ log thao tác và quỹ đạo xe (không có ảnh, không có point cloud) được đẩy lên Supabase,
và chỉ khi extension đã được cấu hình URL và khoá Supabase (`config/database.json`, không commit); mất mạng thì log
xếp hàng trong `chrome.storage` rồi gửi lại.

Tài liệu này mô tả bản `0.19.2`.

## 1. Bối cảnh hệ thống

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
flowchart LR
    A["Annotator"] --> CVAT["CVAT<br/>trang job 3D và server"]
    CVAT <-->|"Lấy dữ liệu frame<br/>Lưu box 3D"| EXT["BoxLift<br/>extension Chrome"]
    EXT -.->|"Log thao tác<br/>(tuỳ chọn)"| SUPA[("Supabase")]
```

## 2. Các khối chức năng

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
flowchart LR
    CVAT["Trang CVAT<br/>point cloud, ảnh camera"] --> IN["Nhập liệu<br/>chọn calib, chiếu LiDAR lên ảnh"]
    IN --> BUILD["Dựng box 3D<br/>từ khung 2D hoặc nhận diện tự động<br/>(mô hình AI chạy trong trình duyệt)"]
    BUILD --> TRK["Track 3D<br/>bám vật thể qua nhiều frame<br/>(tuỳ chọn)"]
    TRK --> EDIT["Chỉnh và duyệt box<br/>tay cầm trên ảnh, 3 khung nhìn<br/>Enter: lưu vào job CVAT"]
    EDIT --> MEA["Đo lường<br/>đồng hồ Tay và Tool, box đã sửa"]
    MEA -.->|"Log"| SUPA[("Supabase")]
```

## 3. Luồng chính: kéo khung 2D ra box 3D, lưu vào CVAT

```mermaid
sequenceDiagram
    actor U as Annotator
    participant B as BoxLift
    participant C as Trang CVAT
    participant M as Mô hình AI
    participant S as CVAT server

    U->>B: Mở BoxLift trên job 3D
    B->>C: Xin point cloud và ảnh camera
    C-->>B: Dữ liệu CVAT đã tải sẵn
    B->>B: Chọn calib theo tên task, chiếu LiDAR lên ảnh
    U->>B: Kéo khung 2D quanh vật thể
    B->>M: Điểm LiDAR trong khung, ảnh crop
    M-->>B: Tâm, kích thước, hướng
    B-->>U: Box 3D và 3 khung nhìn
    U->>B: Chỉnh tay nếu cần, nhấn Enter
    B->>S: Lưu cuboid vào job
```

Xe con dùng MTrans (ảnh + LiDAR, cần WebGPU), xe tải, buýt, xe đạp và người dùng Frustum PointNet (chỉ LiDAR), xe máy và
các trường hợp dự phòng dùng gom cụm hình học. Phím `T` thêm một bước ở đầu: mô hình nhận diện tự khoanh vật thể, mỗi khung
đi qua luồng trên như một khung kéo tay. `Shift+K` (Track 3D) lặp luồng này theo frame.

Calib được chọn theo thứ tự: calib đã lưu cho task, rồi khớp **tên task** với bộ calib có sẵn, rồi người dùng chọn tay hoặc
nạp `calib.json`.

## 4. Đo lường: Làm tay vs Dùng tool

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
flowchart LR
    W["Thao tác trong CVAT"] --> CLK["Đồng hồ Tay và Tool"]
    CLK --> Q["Box máy đề xuất<br/>sửa khi IoU thấp, yaw lệch, đổi nhãn"]
    Q --> TAB["Bảng so sánh<br/>thời gian và chất lượng"]
    TAB --> OUT["Xuất CSV, Markdown"]
```

## 5. Phát hành

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
flowchart LR
    SRC["Mã nguồn"] --> TEST["Chạy test"]
    TEST --> PACK["Đóng gói, kiểm SHA256<br/>kèm mô hình ONNX (không commit)"]
    PACK --> REL["GitHub Release<br/>file zip"]
    REL --> INST["Chrome: Load unpacked"]
```

## 6. Bản demo web

Trang tĩnh trên Vercel chạy nguyên mã extension, không sửa; chỉ thêm lớp giả `chrome.*` và CVAT giả trong trình duyệt.

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
flowchart LR
    PAGE["Trang web demo<br/>index.html, boot.js, màn hình 3D, hướng dẫn 7 bước"] --> SHIM["Lớp giả chrome.*<br/>và CVAT giả trong trình duyệt<br/>(dữ liệu Argoverse 2 đóng gói sẵn)"]
    SHIM --> EXTJS["Script extension nguyên bản<br/>cvat.js và các module"]
    EXTJS <-->|"MessageChannel"| DET["iframe detector"]
    DET -->|"Tải mô hình ONNX"| MB[("MODEL_BASE<br/>URL thư mục mô hình")]
```

Box vẽ trong demo chỉ lưu ở trình duyệt (`localStorage`); không có server nào nhận dữ liệu.

## Quyết định thiết kế

| Quyết định | Lý do |
|---|---|
| Mọi suy luận chạy trong trình duyệt (WebGPU hoặc WASM) | Không gửi ảnh và point cloud ra ngoài; không cần server GPU |
| Lấy frame CVAT đã tải qua plugin API của CVAT | Không tải point cloud hay ảnh lần hai, không cần mật khẩu |
| Mô hình chạy trong iframe ở origin của extension, nói chuyện qua `MessageChannel` | Trang CVAT không đọc được file mô hình hay dữ liệu suy luận |
| Cấu hình DB (`config/database.json`) chỉ đi qua service worker; trang web ngoài chỉ thấy 4 file của extension | Khoá DB không lộ cho trang; mô hình, calib và script không đọc được từ ngoài (xem mục Bảo mật trong [`dac-ta-thiet-ke.md`](dac-ta-thiet-ke.md)) |
| Mô hình chọn theo lớp vật thể, không theo tên nhãn | Job có thể gộp nhiều lớp vào một nhãn (có bước ánh xạ nhãn) |
| Supabase chỉ nhận log thao tác và quỹ đạo xe, mỗi máy là một danh tính đăng nhập ẩn danh | Phục vụ bảng số liệu Làm tay vs Dùng tool; RLS theo `auth.uid()` nên máy này không đọc được dữ liệu máy khác (chi tiết trong [`dac-ta-thiet-ke.md`](dac-ta-thiet-ke.md)) |

Tài liệu liên quan: [`PLAN.md`](../PLAN.md), [`RESEARCH.md`](../RESEARCH.md), [`extension/THIRD_PARTY.md`](../extension/THIRD_PARTY.md).
