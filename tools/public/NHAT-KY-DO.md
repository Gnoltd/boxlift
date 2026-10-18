# Nhật ký đo — tool box 2D → 3D trên dữ liệu công khai (nuScenes)

Mục đích: đo tool **vẽ box 2D trên ảnh → box 3D** (`extension/boxfit.js` `fitFromRect`) so với đáp án có sẵn của
nuScenes, để biết tool đúng tới đâu, sai ở loại vật nào, và mỗi lần sửa code có thật sự tốt hơn không.
Ghi lại đủ đầu vào / đầu ra / chỉ số để người khác chạy lại ra đúng số.

---

## 0. Chỉ số đánh giá đề tài N1-01B (Cuboid từ bbox 2D chiếu sang LiDAR — frustum)

Đề bài: thời gian / cuboid; IoU 3D; sai số orientation (yaw). Cách đo chính thức:

**A. Chất lượng + thời gian máy** — `tools/public/metrics.py` (sau `eval_boxes.js --json` mỗi cảnh). Cảnh 0103, 0916
(mô hình đầu/đuôi và mô hình box frustum không học 2 cảnh này), khung 2D = hình chiếu box đáp án ±3 px, vật ≥ 10 điểm
LiDAR, extension 0.19.0 (xe con: MTrans học KITTI → nuScenes, mục 4.I–4.J; xe tải / buýt / xe đạp / người: box frustum học
trên nuScenes trainval + KITTI, mục 4.H; xe máy: hình học):

| Lớp | n | tạo được | 3D IoU p50 | ≥ 0,5 | ≥ 0,7 | lệch tâm p50 | yaw trục p50 | yaw 360° p50: trước → sau đầu/đuôi | ≤ 10°: trước → sau | máy ms/box |
|---|---|---|---|---|---|---|---|---|---|---|
| xe con | 827 | 98,2% | **0,77** | **92,3%** | **73,5%** | **0,18 m** | 2,5° | 2,8° → **2,6°** | 76,7% → **82,8%** | 22 (+ MTrans ~70 ms / xe WebGPU) |
| xe tải | 73 | 95,9% | 0,67 | **84,9%** | **43,8%** | 0,31 m | 1,1° | 1,3° → 1,3° | 85,7% → 85,7% | 21 |
| xe buýt | 30 | 96,7% | 0,78 | **96,7%** | **66,7%** | 0,33 m | 0,8° | 0,8° → 0,9° | 93,1% → 93,1% | 24 |
| xe máy | 82 | 100% | 0,41 | 31,7% | 3,7% | 0,28 m | 4,7° | 154,7° → 16,1° | 29,3% → 42,7% | 6 |
| xe đạp | 14 | 100% | 0,49 | 50,0% | 7,1% | 0,18 m | 5,7° | 7,8° → 51,1° | 57,1% → 42,9% | 21 |
| người đi bộ | 391 | 99,5% | 0,56 | **64,2%** | 9,2% | 0,10 m | — | (hướng người không xác định từ box) | | 20 |
| **mọi xe** | 1026 | 98,1% | **0,75** | **86,5%** | **64,7%** | **0,20 m** | 2,4° | 2,8° → **2,7°** | 73,7% → **79,4%** | 21 |
| xe con, 0.18.0 (frustum) | 827 | 98,2% | 0,69 | 77,4% | 46,4% | 0,24 m | 2,1° | 2,4° → 2,3° | 74,5% → 79,1% | 21 |
| mọi xe, 0.18.0 (frustum) | 1026 | 98,1% | 0,67 | 74,5% | 42,9% | 0,25 m | 2,1° | 2,5° → 2,4° | 71,9% → 76,5% | 21 |
| mọi xe, 0.17.0 (học nuScenes-mini) | 1026 | 98,1% | 0,61 | 66,5% | 28,8% | 0,32 m | 2,9° | 4,8° → 3,8° | 60,4% → 67,1% | 26 |
| mọi xe, 0.16.0 (chỉ hình học) | 1026 | 98,1% | 0,52 | 51,7% | 25,8% | 0,47 m | 2,5° | 105,7° → 3,9° | 32,7% → 62,4% | 7 |

"máy ms/box" từ 0.17.0 = dựng box hình học + 2 mô hình frustum (node, WASM 1 luồng, lô 64; trong trình duyệt chạy WebGPU).
IoU ≥ 0,5 / 0,7 tính trên mọi vật (không tạo được = trượt); quay 180° không đổi IoU. "yaw trục" = mod 180°;
"yaw 360°" = tính cả đầu/đuôi. Thời gian máy: dựng box trên nuScenes (34 nghìn điểm / sweep) ~7 ms; mô hình
đầu/đuôi thêm ~10–70 ms / vật trong trình duyệt; LiDAR dày (300 nghìn điểm) chậm hơn nhiều (đã thấy 7 s / box).
Xe con 2 cảnh này khó hơn trung bình 10 cảnh (mục 4.0: IoU ≥ 0,5 60%).

**B. Thời gian người / cuboid** — `tools/public/time_study.py` trên CVAT local (script là đồng hồ bấm giờ, tự lấy
cuboid mới từ CVAT và so với đáp án nuScenes). Quy trình:
1. Tạo 2 task cùng cảnh 0916 (chưa có nhãn): `cvat_upload.py <nuscenes-0916-key> --name "nuscenes scene-0916 tool"` và
   `--name "nuscenes scene-0916 tay"` (tên chứa scene-0916 → extension tự chọn calib).
2. Frame 21 (20 xe con ≥ 10 điểm). Gán **mọi xe con thấy được** với chất lượng như khi giao hàng.
3. Lượt **tool trước** (lợi thế quen cảnh dồn cho lượt tay → so sánh thiên về phía an toàn):
   `time_study.py run --mode tool --job <job task tool> --frames 21 --scene <nuscenes-0916-key>` → Enter bắt đầu, dùng
   extension (T / Shift+T hoặc vẽ khung, duyệt, sửa, lưu), Enter khi xong.
4. Lượt **tay**: `--mode manual --job <job task tay>`, chỉ dùng công cụ cuboid của CVAT.
5. `time_study.py report` → bảng: phút, số cuboid, **giây / cuboid**, recall, giây / vật tìm đúng, IoU 3D, lệch tâm,
   yaw 360°, đúng lớp — của từng lượt.
Thử script trên CVAT giả lập (Shift+T, lưu 3 box): ghép đúng box đáp án theo IoU lớn nhất (lần đầu ghép theo tâm gần
nhất → xe tải 10 m bị ghép nhầm người đứng cạnh; đã sửa).

**Kết quả B:** (chưa đo — điền sau khi chạy)

## 1. Đầu vào (input)

| Mục | Giá trị |
|---|---|
| Bộ dữ liệu | nuScenes **v1.0-mini** (`v1.0-mini.tgz`, 4,17 GB, nuscenes.org), giấy phép CC BY-NC-SA 4.0 |
| Vị trí | `~/public-data/nuscenes/` (ngoài repo, không commit) |
| Cảnh | `scene-0061` (đường phố, rẽ, xe tải đỗ), `scene-0655` (bãi đỗ xe), `scene-0916` (bãi đỗ xe, nhiều người), `scene-1077` (ban đêm, đường lớn) |
| Frame | **keyframe** 2 Hz (camera đồng bộ với lượt quét LiDAR), 39–41 frame/cảnh, ~20 s |
| Cảm biến | 6 camera 1600×900 (ảnh đã khử méo, pinhole), LiDAR 32 tia (`LIDAR_TOP`) |
| Calib | **đáp án** của nuScenes (`calibrated_sensor`) → `gt/calib-gt.json` (định dạng của tool) |
| Box đáp án | `sample_annotation` → `gt/boxes.json`, đổi sang hệ toạ độ point cloud (LiDAR) của đúng keyframe |

Chuyển đổi (một lần mỗi cảnh):
```bash
.venv/bin/python tools/public/nuscenes_to_cvat.py --root ~/public-data/nuscenes \
    --scene scene-0061 --out ~/public-data/cvat-upload/nuscenes-0061-key
```
Ra: `pointcloud/<giây>-<nano>.pcd` (x y z rgb, rgb = độ phản xạ), `related_images/<frame>_pcd/image_N.jpg`
(image_1 = CAM_FRONT, 0 = BACK, 2 = FRONT_LEFT, 3 = BACK_LEFT, 4 = FRONT_RIGHT, 5 = BACK_RIGHT),
`gt/calib-gt.json`, `gt/calib-ref.json` (chỉ CAM_FRONT), `gt/frames.json` (thời điểm + vị trí xe của LiDAR và từng
camera), `gt/boxes.json`, `upload.zip` (để tạo task trên CVAT local).

### Cách giả lập "người vẽ box 2D"
Với **mỗi** vật có box đáp án:
1. Lấy lớp: `vehicle.car` → car; `vehicle.truck`, `vehicle.construction` → truck; `vehicle.bus.*` → bus;
   `vehicle.motorcycle`, `vehicle.bicycle`; `human.pedestrian.*` → pedestrian. Lớp khác (rào, cọc…) bỏ.
2. Chỉ lấy vật có **≥ 10 điểm LiDAR** (`num_lidar_pts`).
3. Chọn camera **thấy trọn** vật (8 góc box nằm trong ảnh, trước camera ≥ 0,5 m) và vật **to nhất** trong ảnh đó.
4. Khung 2D = hình chiếu 8 góc box đáp án (chuỗi chiếu chuẩn nuScenes, tính cả chuyển động xe giữa lúc LiDAR quét
   và lúc camera chụp) → **khung bao trọn vật, kể cả phần bị che** (amodal).
5. Mỗi cạnh khung xê dịch ngẫu nhiên **±3 px** (tay người vẽ), seed cố định = 5.

Tool chạy như trong extension: `groundMask` cả lượt quét, `fitFromRect(xyz, calib đáp án, camera, null, khung,
{label, ground})`, **không** bù thời gian (giống extension hiện tại).

---

## 2. Đầu ra (output)

```bash
node tools/public/eval_boxes.js <thư mục cảnh> [--time] [--jitter 3] [--min-pts 10] [--calib x.json] [--json out.json]
node tools/public/box_failures.js out*.json          # phân loại lỗi, gộp nhiều cảnh
```
- Bảng chữ: theo lớp, theo khoảng cách (0–20, 20–40, > 40 m), theo mức che (`visibility` của nuScenes) — cột ở mục 3.
- `--json`: mỗi vật một dòng: `fid, gt (box đáp án), drawn (khung 2D), label, cam, range (m), vis, pts, ok, reason`
  (lý do khi không tạo được), và khi tạo được: `out (box tool), dc, dz, dyaw, dl, dw, dh, bev, iou3d`.
- File kết quả của các lần đo: `work/public/t5-<cảnh>-<phiên bản>.json|txt` (không commit).

---

## 3. Chỉ số đo

| Chỉ số | Định nghĩa |
|---|---|
| **tạo được** (made) | % vật tool trả ra box (không báo "quá ít điểm" / "không gom được cụm" / "chỉ có điểm mặt đất") |
| **lệch tâm** (centre) | khoảng cách tâm box tool ↔ đáp án nhìn từ trên xuống (m); báo trung vị p50 và p90 |
| **lệch góc** (yaw) | chênh hướng box (°), tính modulo 180° (box không phân biệt đầu/đuôi) |
| \|dl\| \|dw\| \|dh\| | sai số dài / rộng / cao (m), trung vị trị tuyệt đối |
| **BEV IoU** | IoU hai hình chữ nhật xoay nhìn từ trên xuống (giao đa giác Sutherland–Hodgman) |
| **3D IoU** | BEV giao × phần chồng theo chiều cao / hợp thể tích |
| **đạt** (good) | lệch tâm ≤ 0,3 m **và** lệch góc ≤ 5° (tính trên mọi vật, kể cả không tạo được) |

Phân loại lỗi (`box_failures.js`), theo thứ tự xét:
`not made` → `wrong object` (BEV IoU < 0,05 và lệch tâm > 1,5 m: lấy nhầm vật khác) → `too big` (dài hơn > 1 m hoặc
rộng hơn > 0,8 m: dính xe bên cạnh) → `yaw off > 30°` → `good` → `too short` (ngắn hơn > 1 m) → `roughly right`.

Chỉ số phụ (T1, `eval_projection.js`): lệch px giữa điểm extension chiếu và chuỗi chiếu chuẩn nuScenes, theo camera,
trung vị / p90; `--time` thêm bù lệch thời gian camera–LiDAR.

---

## 4. Kết quả

### 4.J MTrans trong extension (0.19.0) (11/10/2026)

- Xuất ONNX: `public-data/mtrans/export_onnx.py` — cùng trọng số, cùng phép tính của `MTrans.forward` lúc eval, bỏ phần chỉ
  dùng khi học, viết lại chỗ không xuất được (ghi đè lát cắt, chỉ số theo lô) → `extension/models/mtrans.onnx` 84 MB, opset
  17. Kiểm tra trên 16 xe thật: lệch so với PyTorch gốc ≤ 5e-7 (PyTorch), ≤ 2e-6 (onnxruntime-web WASM và WebGPU).
- Tốc độ (Mac, Chrome trong app): WebGPU 51 ms / xe (lô 16), 79 ms (1 xe); nạp mô hình 1,1 s lần đầu; WASM 1 luồng
  2,1 s / xe → extension chỉ dùng MTrans khi có WebGPU, không có thì giữ box frustum.
- Đầu vào dựng bằng JS (`extension/mtrans.js`), đúng các bước dữ liệu lúc học (hệ trục theo camera, crop 112 khớp góc
  bilinear, kênh che, 512 điểm + ô trống lấy pixel). Kiểm tra: `tests/mtrans.test.js` (16 mục); trang thử dùng đúng
  `detector.js` + `mtrans.js` trên khung 0103 `1533151620-447745000` (19 xe, ảnh giải mã bằng canvas): box trùng `node`
  (ảnh giải mã bằng Pillow) tới 3 chữ số; 19 xe: chuẩn bị 90 ms, mô hình 1,37 s (lần đầu 3,2 s có nạp).
- Đo như extension: `eval_boxes.js --learned work/frustum/tv/onnx --mtrans extension/models/mtrans.onnx` (MTrans thay box
  cho xe con có box, frustum cho lớp khác) → `work/public/M-<cảnh>.json`; `metrics.py` → bảng mục 0. IoU xe con khớp đo
  bằng Python (4.I: p50 0,79 cảnh 0103).
- Lỗi tìm thấy: bản đầu xe con yaw 360° ≤ 10° sau đầu/đuôi chỉ **69,1%** (frustum 79,1%) dù IoU cao: 156 / 812 box MTrans ra
  **dài và rộng đổi chỗ, hướng lệch 90°** (cùng một hình chiếu, IoU vẫn cao, nhưng đầu xe chỉ ngang). Đã thử (cùng 2 cảnh):

| xe con, sau bước đầu/đuôi | IoU ≥ 0,7 | yaw trục p50 | yaw 360° ≤ 10° |
|---|---|---|---|
| MTrans nguyên | 73,5% | 3,1° | 69,1% |
| hướng của frustum + box MTrans | 58,2% | 2,1° | 79,4% |
| **cạnh dài = chiều dài (đổi lại + xoay 90°), đổi thì đầu/đuôi để mô hình ảnh (odds 1)** | **73,5%** | **2,5°** | **82,8%** |
| như trên + đầu/đuôi theo frustum khi đổi | 73,5% | 2,5° | 83,3% |
| như trên + ghép odds 2 mô hình | 73,5% | 2,5° | 83,6% |

  → chọn dòng in đậm (đơn giản, không cần chạy frustum cho xe con; 2 dòng dưới hơn < 1 điểm, chọn trên chính 2 cảnh đo).
- Bản cuối (bảng mục 0), xe con: IoU ≥ 0,5 77,4% → **92,3%**, ≥ 0,7 46,4% → **73,5%**, lệch tâm 0,24 → **0,18 m**,
  yaw 360° ≤ 10° sau đầu/đuôi 79,1% → **82,8%**. Mọi xe ≥ 0,7 42,9% → 64,7%.
- Lưu ý: best_model chọn theo 827 xe 0103 / 0916 (cũng là bộ đo) → số có thể hơi lạc quan; cần thêm cảnh nuScenes khác.

### 4.I Tái tạo MTrans (ECCV 2022) trên KITTI (10/10/2026)
- Đầu vào: mã MTrans (github.com/Cliu2/MTrans, MPL-2.0) bản sửa chạy không cần biên dịch CUDA; KITTI 3D object (công khai), cấu hình gốc `MTrans_kitti.yaml` (500 khung có nhãn + phần còn lại không nhãn, 300 epoch). Chạy trên Kaggle GPU T4 (notebook và dataset riêng tư), ngoài repo.
- Cách chạy: epoch 0–117 fp32 (`mtrans1`, ~6 phút/epoch, dừng tay trước giới hạn 12 giờ, lấy `last.pt`); epoch 118–299 mixed precision (`mtrans2`, ~3 phút/epoch, học tiếp từ `last.pt`). Đánh giá luôn fp32.
- Nối fp32 → AMP liền mạch (train, cùng epoch-size): epoch 117 fp32 L 1,86 / IoU 74,4 / R 75,6; epoch 118 AMP L 1,86 / IoU 74,6 / R 74,8. Không có NaN. Epoch 299: L 1,02, IoU 84,6, R 94,6 (train).
- **Kết quả KITTI val (xe con, giao thức của MTrans): IoU 3D trung bình 77,36%, recall IoU≥0,7 80,24%, đúng hướng 87,4%, seg 92,7%.** Bài báo: recall 81,2% → kém ~1 điểm, coi như tái tạo được.
- So với frustum 0.18.0 trên KITTI val (4.H): recall IoU≥0,7 49,9% → 80,2%.
- File: `public-data/mtrans_out/v2/out/repro/ckpt/best_model.pt` (250 MB, 20,9M tham số), `train.log`.
- **So cùng xe, cùng cách đo** (`dump_val.py` của MTrans + `frustum_dump.py`, cùng hàm `bev_iou` của
  `tools/frustum/train.py`; ghép theo khung + khung 2D): 13 416 xe con KITTI val (13 726 xe của MTrans, bộ lọc
  cắt ≤ 0,95 và ≥ 5 điểm trên xe; 310 xe không có trong bộ frustum vì frustum bỏ mẫu < 8 điểm trong khung 2D). Kiểm tra
  chéo: MTrans trên cả 13 726 xe bằng hàm của mình ra recall IoU ≥ 0,7 80,3% (log MTrans 80,24%) → khớp.

| xe con KITTI val | n | IoU3D p50 | ≥ 0,5 | ≥ 0,7 | lệch tâm p50 | yaw trục p50 | yaw 360° ≤ 10° | ngược đầu (> 90°) |
|---|---|---|---|---|---|---|---|---|
| MTrans | 13 416 | **0,81** | **94,5%** | **81,5%** | **0,15 m** | 1,7° | 73,6% | 14,1% |
| frustum 0.18.0 | 13 416 | 0,71 | 81,7% | 51,3% | 0,24 m | 1,8° | **80,9%** | **11,5%** |

  Theo khoảng cách, IoU ≥ 0,7 MTrans / frustum: 0–15 m 87 / 64 · 15–30 m 85 / 63 · 30–50 m 79 / 37 · > 50 m 60 / 14.
  Theo số điểm LiDAR trong khung 2D: < 30 điểm 69 / 13 · 30–100 82 / 31 · ≥ 100 83 / 59.
  → MTrans hơn rõ ở vị trí + kích thước, nhất là xe xa / ít điểm (đúng điểm yếu của mình). Đầu / đuôi MTrans kém hơn
  (ngược đầu 14% so với 11,5%; chưa ghép mô hình hướng ảnh của extension — trong extension bước này đang đưa frustum lên 88%).
- **nuScenes 0103 / 0916 (cảnh không học), xe con**: `nus2kitti.py` chuyển mỗi (khung, camera) thành 1 khung KITTI
  (ảnh, LiDAR, calib, nhãn), khung 2D = đúng khung `drawn` frustum đã nhận trong `work/public/T-<cảnh>.json`; hệ
  "velodyne" = hệ pcd xoay quanh z cho trục x nhìn theo camera (giống KITTI). Kiểm tra: GT MTrans đọc lại khớp GT gốc
  (< 1 cm). 827 xe, so trên 812 xe frustum có box:

| nuScenes xe con | IoU3D p50 | ≥ 0,5 | ≥ 0,7 | lệch tâm BEV p50 | yaw trục p50 | yaw 360° ≤ 10° | ngược đầu |
|---|---|---|---|---|---|---|---|
| MTrans (chỉ học KITTI) | 0,61 | 66,7% | 32,9% | 0,30 m | 19,8° | 33,0% | 32,5% |
| frustum 0.18.0 (box, chưa ghép ảnh) | **0,69** | **78,8%** | **47,3%** | **0,24 m** | **2,1°** | **74,5%** | **16,9%** |

  Lỗi MTrans chủ yếu ở hướng: xe gần song song tia nhìn sai trục 3,5° (p50), xe chéo 30–60° sai 42°, xe ngang 60–90°
  sai 77° → MTrans học thuộc "xe nằm dọc trục x" của KITTI (camera trước, xe chạy dọc đường). Theo camera: CAM_FRONT
  4,4°, CAM_FRONT_LEFT 3,6°, CAM_BACK 61°, CAM_FRONT_RIGHT 42°. Chiều dài đoán ngắn (p50 3,5 m, thật 4,6 m).
  Thử hệ x = hướng xe ego cho mọi camera: tệ hơn (≥ 0,7 13,5%, yaw trục 33°) → giữ hệ theo camera.
  Kết luận: MTrans học trên KITTI không mang sang nuScenes được (LiDAR 32 tia, 6 camera quanh xe); muốn dùng phải học
  lại trên nuScenes. Trên KITTI MTrans hơn rõ (81,5% so với 51,3% ở ≥ 0,7).
- **Học lại trên nuScenes (10/10/2026, bắt đầu)**: `nus_train_data.py` — trainval 848 cảnh (bỏ 0103, 0916), 1/3 khung
  chính, xe con ≥ 5 điểm trong box, mỗi xe gán camera thấy nó rõ nhất (khung 2D = box 3D chiếu, cắt theo ảnh, bỏ phần
  bị cắt > 95%), hệ trục theo camera như `nus2kitti.py` → ~85 nghìn xe, bốc ngẫu nhiên 60 000; crop 112×112 lưu uint8
  (3,0 GB, ~50 KB/xe). Kiểm tra: 827 xe 0103 / 0916 (như trên). Khởi tạo từ MTrans-KITTI (chỉ trọng số), 13 epoch,
  batch 16 có nhãn (bỏ nhánh không nhãn), lr 1e-4 cosine, AMP, kiểm tra mỗi epoch, Kaggle T4 (`mtrans-nus`, riêng tư),
  dừng gọn trước 11 giờ. Chạy thử trên Mac 4 bước: OK; MTrans-KITTI chưa học trên 16 xe kiểm tra đầu: IoU 0,73, R 0,56.
  Lần 1 (`mtrans-nus` v1, 10/10 23:30): đọc 60 nghìn file nhỏ thẳng từ `/kaggle/input`, log Kaggle hỏng (500 / trống),
  2,5 giờ không thấy gì → dừng, output trống. Lần 2 (v2, 11/10 02:18): chép dữ liệu sang `/tmp` trước (599 s), in tiến
  độ mỗi 200 bước → 0,69 s/bước, 0,73 giờ/epoch, xong 12:18 (~10 giờ GPU).
  Đánh giá của MTrans mỗi epoch (827 xe; IoU = IoU 3D TB, R = recall ≥ 0,7): 0: 62,4 / 42,8 · 2: 66,3 / 52,4 ·
  4: 68,6 / 60,9 · 6: 71,2 / 65,3 · 8: 74,4 / 73,6 · 10: 75,7 / 76,5 · 11: 76,4 / 79,7 · 12: 76,4 / 78,5 (best_model = epoch 12).
- **MTrans học nuScenes vs frustum 0.18.0, cùng 812 xe, cùng hàm đo** (`public-data/mtrans_out/nus2/.../best_model.pt`):

| nuScenes xe con | IoU3D p50 | ≥ 0,5 | ≥ 0,7 | lệch tâm BEV p50 | yaw trục p50 | yaw 360° ≤ 10° | ngược đầu |
|---|---|---|---|---|---|---|---|
| MTrans chỉ KITTI | 0,61 | 66,7% | 32,9% | 0,30 m | 19,8° | 33,0% | 32,5% |
| **MTrans KITTI → nuScenes** | **0,79** | **95,4%** | **78,8%** | **0,14 m** | 2,9° | 69,5% | **12,7%** |
| frustum 0.18.0 (box, chưa ghép ảnh) | 0,69 | 78,8% | 47,3% | 0,24 m | **2,1°** | **74,5%** | 16,9% |

  Theo khoảng cách (≥ 0,7, MTrans / frustum): 0–20 m 85 / 60 · 20–40 m 74 / 35. Theo số điểm: < 30 điểm 68 / 29 ·
  30–100 88 / 61 · ≥ 100 98 / 83. Hơn rõ ở vị trí + kích thước; hướng trục kém hơn chút (2,9° so với 2,1°, xấu nhất cảnh
  0916: 4,2°, ≤ 10° 61%) → khi tích hợp nên giữ bước ghép đầu/đuôi từ ảnh và thử lấy hướng từ frustum khi lệch nhiều.

### 4.H Frustum học trên nuScenes trainval + KITTI (extension 0.18.0) (09/10/2026)

- Dữ liệu học (`tools/frustum/data.py`, khung chính, không sweep): nuScenes v1.0-trainval, 840 cảnh (10 part "Keyframe
  blobs only", bỏ 10 cảnh mini) → 395 nghìn mẫu (`nus-tv-0..10.npz`, chia 11 phần chạy song song); KITTI 3D object train
  (3 712 khung, chia train/val chuẩn của F-PointNet) → ~16 nghìn mẫu; + nuScenes-mini 8 cảnh (khung chính + sweep).
  Tổng 436 813 mẫu: xe con 242 778, xe tải 80 627, buýt 12 380, xe máy 6 087, xe đạp 5 982, người 88 959.
- Học: `train.py --epochs 40 --epoch-size 100000 --balance 0.3 --workers 4` (mỗi epoch bốc 100 nghìn mẫu, lớp hiếm
  được bốc nhiều hơn: trọng số = số mẫu^-0,3), MPS, 143–160 s/epoch, tổng 1,7 giờ → `work/frustum/tv/model.pt`.
  Dữ liệu đọc qua memory-map (`*.cache/*.npy`): lần đầu 4 worker × bản sao riêng làm máy lên 29 GB RAM; sau khi sửa
  ~8 GB, máy còn trống 79%.
- Đo trong học (cảnh 0103, 0916, khung 2D đáp án), bản mini → bản trainval: IoU ≥ 0,5 / ≥ 0,7
  xe con 62,5 / 29,4 → **70,9 / 41,7**; xe tải 74 / 25 → **82 / 43**; buýt 78 / 46 → **100 / 70**; xe máy 16 / 1 → 29 / 2;
  xe đạp 17 / 0 → **61 / 9**; người 51 / 5 → **64 / 8**.
- Đo như extension (`eval_boxes.js --learned work/frustum/tv/onnx`, `work/public/T-<cảnh>.json`), học / hình học:

| Lớp | n | IoU p50 | ≥ 0,5 | ≥ 0,7 | yaw trục p50 | yaw 360° ≤ 10° (mô hình box, chưa ghép ảnh) |
|---|---|---|---|---|---|---|
| xe con | 812 | **0,69** / 0,55 | **79%** / 55% | **47%** / 28% | 2,1° / 2,6° | 75% |
| xe tải | 70 | **0,67** / 0,41 | **89%** / 39% | **46%** / 14% | 1,1° / 0,9° | 86% |
| xe buýt | 29 | **0,78** / 0,73 | **100%** / 66% | **69%** / 52% | 0,8° / 0,7° | 93% |
| xe máy | 82 | 0,40 / 0,41 | 26% / **32%** | 1% / 4% | 8,2° / 4,8° | 28% |
| xe đạp | 14 | **0,51** / 0,41 | **50%** / 21% | 7% / 7% | 5,8° / 17,3° | 57% |
| người | 389 | **0,56** / 0,35 | **65%** / 21% | **9%** / 1% | 18,5° / 54,5° | — |

  → `Frustum.USE`: thêm xe đạp; xe máy vẫn hình học (học kém 6 điểm). Mô hình 2 bước ~15 ms / vật (node).
- Đầu / đuôi: mô hình box giờ đoán hướng tốt hơn → ghép lại (`PRIOR_W`), đúng chiều (lệch < 90°), xe con / tải / buýt /
  xe đạp, 925 box: w = 0 (chỉ ảnh) 83,0% · 0,5 86,5% · 1 87,2% · **2 88,1%** · 3 88,6% · 5 88,0% · chỉ mô hình box 83,7%.
  Chọn 2 (giữa vùng ổn định 2–3; chọn trên chính 2 cảnh đo).
- **KITTI val** (3 769 khung không học, LiDAR 64 tia; `train.py --test kitti-val.npz --init … --epochs 0`, khung 2D
  của nhãn KITTI): IoU ≥ 0,5 / ≥ 0,7, bản mini → bản trainval: xe con (15 319) 55,5 / 15,2 → **79,9 / 49,9**; xe tải
  (599) 16,7 / 3,5 → **73,5 / 14,2**; xe đạp (Cyclist, 717) 13,2 / 0,3 → **77,7 / 28,3**; người (2 186) 57,3 / 6,1 →
  62,8 / 8,0.
- Kết quả cuối (bảng mục 0): mọi xe IoU ≥ 0,5 66,5 → **74,5%**, ≥ 0,7 28,8 → **42,9%**, lệch tâm 0,32 → 0,25 m,
  yaw 360° ≤ 10° 67,1 → **76,5%**; người ≥ 0,5 53,5 → 64,2%.

### 4.G Box từ mô hình học: Frustum PointNet (extension 0.17.0) (09/10/2026)

Mục 4.F: lỗi chính là tách điểm của vật + ước phần khuất → học cả hai (Frustum PointNets v1, bản nhẹ, `tools/frustum/`):
điểm LiDAR trong khung 2D (xoay về trục khung nhìn) → **mô hình tách** (điểm nào là vật) → **mô hình box** (tâm, kích
thước so với cỡ trung bình lớp, hướng 12 ngăn + phần dư). Chỉ dùng xyz, không cần calib lúc học.

- Dữ liệu học: nuScenes-mini 8 cảnh (bỏ 0103, 0916): khung hình chính (`nus-mini-train.npz`) + sweep xen giữa, box
  đáp án nội suy giữa 2 khung chính (`--sweeps 2`, `nus-mini-sweeps.npz`, 19 599 mẫu). Khung 2D = hình chiếu box đáp án
  (camera thấy nhiều nhất, ≥ 60% trong ảnh), lúc học lắc ±10%, 20% cắt bớt, bỏ điểm, lật gương.
- Học: 30 epoch, Adam 1e-3, lô 64, MPS (Mac) ~41 s/epoch → `work/frustum/mini/model.pt` (3,6 MB);
  ONNX `frustum_seg.onnx` + `frustum_box.onnx` (`tools/frustum/export.py`).
- Đo trong học (cảnh 0103, 0916, khung 2D đáp án, không lắc): xe con IoU 3D ≥ 0,5 62,5% / ≥ 0,7 29,4%, xe tải 74% / 25%,
  buýt 78% / 46%, xe máy 16% / 1%, xe đạp 17% / 0%, người 51% / 5%; tách điểm đúng 78–89%.
- Đo như extension (`eval_boxes.js <cảnh> --learned work/frustum/mini/onnx --json work/public/L-<cảnh>.json`: khung ±3 px,
  điểm trong khung lấy từ `fitFromRect` → `extension/frustum.js` → onnxruntime-web; box hình học giữ ở `row.geo`):

| Lớp (0103 + 0916) | n | IoU p50 học / hình học | ≥ 0,5 học / hình học | ≥ 0,7 học / hình học | yaw trục p50 học / hình học |
|---|---|---|---|---|---|
| xe con | 812 | **0,63** / 0,55 | **71%** / 55% | **33%** / 28% | 2,9° / 2,6° |
| xe tải | 70 | **0,63** / 0,41 | **79%** / 39% | 17% / 14% | 1,5° / 0,9° |
| xe buýt | 29 | 0,70 / 0,73 | **83%** / 66% | 52% / 52% | 2,3° / 0,7° |
| xe máy | 82 | 0,24 / **0,41** | 11% / **32%** | 0% / 4% | 21,1° / 4,8° |
| xe đạp | 14 | 0,37 / 0,41 | 21% / 21% | 0% / 7% | 14,8° / 17,3° |
| người đi bộ | 389 | **0,52** / 0,35 | **54%** / 21% | 7% / 1% | 24,8° / 54,5° |

  → extension dùng box học cho xe con / tải / buýt / người, giữ hình học cho xe máy / xe đạp (`Frustum.USE`; mini chỉ
  có ~130 xe máy, ~40 xe đạp để học). Nếu chọn được box tốt hơn cho từng xe (không làm được, chỉ để biết trần):
  xe con ≥ 0,5 80%, ≥ 0,7 44%.
- **Đầu / đuôi**: mô hình box tự đoán hướng 360° (xe con ≤ 10°: 63,9% trước bước ảnh; xe tải 78,6%, nhưng buýt 17%).
  Ghép với mô hình ảnh: lật nếu `mật độ_ảnh(đầu kia) · odds^w > mật độ_ảnh(đầu này)`, odds = xác suất ngăn hướng nửa
  vòng đối diện / nửa vòng này (`Frustum.endOdds`). Đúng chiều (lệch < 90°), xe con / tải / buýt, 911 box:

| w | 0 (chỉ ảnh) | 0,25 | **0,5** | 0,75 | 1 | 2 | chỉ mô hình box |
|---|---|---|---|---|---|---|---|
| xe con | 85,0% | 86,2% | **86,3%** | 85,7% | 85,8% | 85,0% | 78,7% |
| xe tải | 67,1% | 70,0% | **75,7%** | 78,6% | 81,4% | 84,3% | 85,7% |
| xe buýt | 69,0% | 65,5% | **65,5%** | 55,2% | 44,8% | 31,0% | 20,7% |
| tất cả | 83,1% | 84,3% | **84,9%** | 84,2% | 84,2% | 83,2% | 77,4% |

  → `Heading.PRIOR_W = 0.5` (chọn trên chính 2 cảnh đo; 1 tham số, lệch nhỏ). Thử ngưỡng tin cậy của ảnh thay vì ghép:
  kém hơn (tốt nhất 83,8% ở ngưỡng 2).
- Kết quả cuối (bảng mục 0, `metrics.py --rows 'work/public/L-{scene}.json'`): mọi xe IoU ≥ 0,5 51,7 → **66,5%**,
  ≥ 0,7 25,8 → **28,8%**, lệch tâm 0,47 → 0,32 m, yaw 360° ≤ 10° 62,4 → **67,1%**; người IoU ≥ 0,5 20,7 → 53,5%.
- Thời gian: 2 mô hình ~17 ms / vật trong node (WASM 1 luồng, lô 64). Trình duyệt (CVAT giả lập, cảnh 0061 frame 0,
  Shift+T 6 camera, WebGPU): 3 box, tổng 1,3 s = nhận diện 0,2 s · dựng 0,1 s · **mô hình frustum 0,1 s** (lần đầu 0,5 s
  do tải mô hình) · đầu/đuôi 0,1 s.
- Bản đưa vào extension: học lại cùng cách trên cả 10 cảnh (`work/frustum/mini-all`), không đo được trên cảnh riêng nữa
  (số trên là của bản không học 0103 / 0916).
- Tiếp: thêm KITTI 3D (7 481 khung) + nuScenes trainval (850 cảnh) để học → xe máy / xe đạp / buýt.

### 4.F Lỗi nằm ở bước nào (thử "giả sử bước X hoàn hảo") (09/10/2026)

`eval_boxes.js --oracle cluster|points` (10 cảnh, như 4.0, extension 0.16.0): tool được cho điểm của vật thật (box
đáp án +10 cm) thay cho một bước — `cluster`: chọn đúng cụm chứa nhiều điểm của vật nhất; `points`: đúng các điểm của
vật (trên mặt đất). Không dùng trong extension, chỉ để biết bước nào còn nhiều chỗ để cải thiện.

| | xe con đạt | IoU ≥ 0,5 | ≥ 0,7 | lệch tâm | xe tải IoU ≥ 0,5 | ≥ 0,7 | xe buýt IoU ≥ 0,5 | xe máy IoU ≥ 0,5 |
|---|---|---|---|---|---|---|---|---|
| hiện tại | 36,4% | 60,1% | 31,3% | 0,38 m | 41,2% | 13,9% | 60,8% | 35,5% |
| chọn cụm hoàn hảo | 36,7% | 63,8% | 31,9% | 0,36 m | 42,3% | 14,5% | 59,3% | 34,0% |
| tách điểm hoàn hảo | **48,8%** | **76,5%** | **41,3%** | 0,26 m | **60,9%** | **27,8%** | 70,9% | 46,1% |

Kết luận: chọn cụm gần đủ tốt (+4 điểm); phần lớn lỗi là **tách điểm của vật** (cụm lẫn điểm nền / vật cạnh, hoặc thiếu
phần xe) → +16 điểm IoU ≥ 0,5 xe con, +20 điểm xe tải. Ngay cả khi điểm hoàn hảo, IoU ≥ 0,7 chỉ 41%: phần còn lại là
**ước box từ điểm thấy một phần** (phía khuất, kích thước) — cần mô hình học (bước 2 của Frustum PointNets).

### 4.E Tốc độ (extension 0.16.0) (09/10/2026)

**Vấn đề:** khung duyệt ghi "thời gian 7256 ms" cho một box tự động trên LiDAR dày (~300 nghìn điểm, nhiều camera). Thực ra
đó là thời gian **cả lượt Shift+T** (nhận diện mọi camera + dựng 24 box), hiển thị nhầm dưới từng box. Phần lớn là mô hình
nhận diện YOLOX-S chạy trên CPU một luồng (~0,7 s / camera), lần lượt từng camera.
**Sửa:**
1. YOLOX và mô hình đầu/đuôi chạy trên GPU (WebGPU, onnxruntime-web 1.30 bản webgpu; không có GPU → WASM như cũ).
2. Nhận diện camera kế tiếp song song khi đang dựng box camera hiện tại (trang nhận diện chạy ở tiến trình riêng);
   đầu/đuôi cho mọi box của lượt trong một lần chạy mô hình.
3. Khung duyệt: "16 ms · cả lượt 0,4 s (6 camera: nhận diện · dựng · đầu/đuôi)"; nguồn box ghi "tự động" (trước ghi
   nhầm "lan").
4. Dựng box trên LiDAR dày: gom cụm theo ô eps/2 (các điểm cùng ô chắc chắn nối nhau; hai ô nối khi tâm đủ gần, nếu
   không thì khi có một cặp điểm nối — cùng kết quả như từng điểm); toạ độ ảnh trong mảng thay vì Map; phép thử khe
   của gộp mảnh trên đường viền thưa 10 cm (ngưỡng bù +0,14 m).
**Đo:**
- CVAT giả lập (cảnh 0061, 6 camera, máy Mac, trình duyệt trong app): cả lượt Shift+T ~4,6 s → **0,4 s** (lần đầu 1,6 s
  gồm nạp mô hình); mô hình nhận diện 6 camera 0,2–0,3 s.
- Dựng box, mây điểm dày giả lập (`eval_boxes.js --dense 9`: mỗi điểm ×9 lệch ±2 cm, ~300 nghìn điểm; 3 cảnh × 4
  frame, 84 box): tổng 4,0 → **2,2 s**, p90 94 → 46 ms, lâu nhất 224 → 82 ms; 3D IoU ≥ 0,5 38,1 → 40,5%.
- 10 cảnh nuScenes (thưa): mọi lớp trong ±0,6 điểm (xe con IoU ≥ 0,5 60,4 → 60,1%, xe buýt ≥ 0,7 31,7 → 32,2%,
  xe tải ≥ 0,7 14,5 → 13,9%: vài box sát ngưỡng gộp mảnh); dựng box p50 7,5 ms.
**Đã thử và bỏ:** (1) nối ô chỉ bằng tâm ô: nhanh hơn nhưng tách nhầm xe (IoU ≥ 0,5 38,1 → 33,3%); (2) lọc thưa 5 cm
trước L-shape: không nhanh hơn, góc kém đi.
Chưa đo trên GPU máy người dùng / dữ liệu dày thật: Chrome trên Mac có WebGPU; console ghi
`[lidar-cam] auto …: … s = detect … · fit … · heading …` mỗi lượt.

### 4.D Đầu / đuôi trên camera fisheye: ảnh nắn (extension 0.15.2) (09/10/2026)

**Vấn đề (test trên CVAT local, camera fisheye):** xe vẫn sai đầu/đuôi. Mô hình 4.B học trên ảnh nuScenes (camera
thường), cắt ảnh theo khung chiếu rồi ép vuông; trên fisheye xe ở rìa ảnh bị cong / méo → khác ảnh lúc học.
**Sửa:** cắt qua camera ảo nhìn thẳng vào xe (`tools/heading/rectify.py` = `extension/heading.js rectify`): camera ảo
đặt tại tâm camera thật, trục quang hướng vào tâm box, khung = 8 góc box chiếu vào camera ảo +15%, mỗi điểm ảnh tra
ngược qua đúng mô hình camera thật (pinhole / Kannala-Brandt), nội suy song tuyến, xe lớn vẽ ×(1–4) rồi lấy trung bình;
< 30% nằm trong ảnh → bỏ. alpha = hướng xe trong camera ảo. Học lại trên ảnh nắn (cùng 11 292 vật, cùng cách học).
**Khớp JS ↔ Python:** 48 trường hợp (thường + fisheye): cùng quyết định có/không ảnh, ảnh lệch trung bình ≤ 0,85 mức
sáng, alpha trùng; 2–70 ms mỗi vật.
**Đo fisheye giả lập** (`tools/heading/eval_fisheye.py`; không có dữ liệu fisheye công khai kèm box 3D trên máy):
ảnh nuScenes 2 cảnh không học bẻ sang fisheye Kannala-Brandt (k1 = −0,35), box đáp án, biết trục đúng, 1290 vật:

| | thường, cũ | thường, mới | fisheye, cũ | fisheye, mới |
|---|---|---|---|---|
| mọi xe | 80,8% | 83,2% | 79,8% | **83,3%** |
| xe con (1059) | 84,3% | 87,1% | 84,3% | 87,3% |
| xe buýt (37) | 51,4% | 62,2% | 35,1% | 67,6% |
| xe máy (88) | 62,5% | 67,0% | 58,0% | 64,8% |
| xe tải (90) | 73,3% | 67,8% | 72,2% | 66,7% |

Ảnh nuScenes chỉ rộng ~70° nên fisheye giả lập nhẹ hơn fisheye thật (xe ở rìa 60–90°); ảnh mẫu cho thấy cách cũ cắt
ra xe cong / vệt kéo dài ở mép ảnh, cách mới ra xe thẳng. Điểm chính: cách mới cho cùng kết quả trên ảnh thường và
fisheye. Xe tải giảm nhẹ (90 vật).
**Box của tool** (eval_end.py, như 4.B, ảnh thường): mọi xe 80,5 → 81,6%, xe con 85,0 → 86,8%, xe buýt 80 → 64%
(25 xe), xe máy 60 → 63%.
Bản đóng gói học lại trên cả 10 cảnh. Mock CVAT cảnh 0061 frame 0: xe tải trước đây box ngang (3°, dài 3,6 m) nay
93°, 7,5 × 2,88 m (đáp án 91,4°, 10,2 × 2,88 m) — nhờ gộp mảnh 4.C.

### 4.C Gộp mảnh cùng một xe (extension 0.15.1) (09/10/2026)

**Vấn đề (thấy khi test trên CVAT local, LiDAR dày):** đầu xe trắng bị tách khỏi thân bởi một khe không có điểm → gom cụm
ra 2 cụm, tool chỉ lấy 1 → box dài 3,6 m, thiếu đầu xe; điểm đầu xe vẫn có (màu xám ở màn Hông).
**Sửa:** sau khi chọn cụm chính, gộp các cụm nằm ≥ 60% trong khung 2D, cách cụm chính < 1 m (nhìn từ trên), khi cả khối
vẫn vừa cỡ lớp: cạnh dài ≤ 1,2 × dài mẫu, cạnh ngắn ≤ max(cạnh ngắn cụm chính, rộng mẫu) + 0,15 m (`mergePieces`).
**Đã thử và bỏ:** (1) chỉ giới hạn cỡ ≤ 1,25 × dài, 1,3 × rộng: xe con IoU ≥ 0,5 giảm 60,3 → 58,5% (gộp cột / bụi bên
hông → box ngắn và rộng ra, vd cảnh 0553 xe 480 điểm còn dài 2,5 m); (2) đoán trục từ cụm chính rồi chỉ cho dài theo
trục: cụm chính nhìn thấy gần vuông → đoán sai trục, không gộp được đầu xe khe 0,6–0,8 m.
**Test giả lập** (`tests/split.test.js`): xe 4,7 m, đầu xe tách bởi khe 0,4 / 0,6 / 0,8 m: bản cũ dài 3,1 / 2,5 / 2,5 m,
bản mới 4,32 m, mép trước đúng (±0,02 m); cột cách hông xe 0,6 m không bị gộp.
**10 cảnh nuScenes** (eval_boxes.js, như 4.0; nuScenes 32 tia ít khi tách nên tác dụng nhỏ):

| Lớp | đạt trước → sau | 3D IoU ≥ 0,5 | 3D IoU ≥ 0,7 |
|---|---|---|---|
| xe con (2283) | 35,9 → 36,5% | 60,3 → 60,4% | 31,0 → 31,4% |
| xe tải (345) | 12,2 → 12,5% | 39,7 → 41,2% | 13,6 → 14,5% |
| xe buýt (199) | 19,6 → 22,1% | 58,8 → 60,8% | 28,1 → 31,7% |
| xe máy (141) | 19,9 → 27,0% | 29,8 → 35,5% | 3,5 → 6,4% |
| người, xe đạp | không đổi | | |

### 4.B Đầu / đuôi xe từ ảnh (mô hình hướng, extension 0.15.0) (09/10/2026)

**Vấn đề:** box tool lấy trục xe từ LiDAR (lệch ~2°) nhưng điểm LiDAR của đầu và đuôi xe giống nhau → box có trục đúng
mà mũi tên hướng ngược: chỉ 45% xe con đúng đầu/đuôi (bằng tung đồng xu).
**Mô hình:** MobileNetV3-small (trọng số ImageNet, torchvision, BSD) → 8 ô góc quan sát alpha (hướng xe so với tia từ
camera tới xe; 0 = thấy đuôi, ±180° = thấy đầu). Ảnh vào: khung chiếu của box +15% lề, co về 128×128.
Chọn trong 2 hướng của trục LiDAR hướng mô hình thấy hợp hơn (`extension/heading.js`).
**Dữ liệu học:** `tools/heading/make_crops.py` cắt 11 292 ảnh vật có box đáp án từ 10 cảnh nuScenes-mini (car 5625,
pedestrian 3956, truck 748, motorcycle 394, bus 381, bicycle 188; khung ≥ 24 px, ≥ 60% trong ảnh, ≥ 1 điểm LiDAR).
**Học:** `tools/heading/train.py`, 15 epoch, AdamW + OneCycle 1e-3, batch 128, Mac MPS ~3,5 phút. Tăng cường: khung
xê dịch / cắt bớt (giống người hoặc mô hình vẽ), lật ngang (alpha → −alpha), màu.
**Kiểm tra trung thực:** học trên 8 cảnh, đo trên 2 cảnh không học (scene-0103, scene-0916: 3565 ảnh).

Mô hình riêng (biết trục đúng, chọn đầu/đuôi): đúng 75,1% (xe con 78,5%, người 74,7%, xe tải 66,4%, xe máy 64,6%,
buýt 50% / 38 ảnh, xe đạp 22% / 40 ảnh); lệch góc alpha trung vị 28°. Khung ≥ 80 px: 76,0%.

**Box của tool trước → sau** (`tools/heading/eval_end.py`: box từ khung 2D giả lập của mục 4.0 trên 2 cảnh không học,
chỉ box có trục đúng ±20°, đúng = hướng lệch < 90° so với đáp án):

| | số box | trước | sau |
|---|---|---|---|
| **xe con** | 646 | 45,4% | **85,0%** |
| xe tải | 61 | 39,3% | 62,3% |
| xe máy | 65 | 43,1% | 60,0% |
| xe buýt | 25 | 0% | 80,0% |
| xe đạp | 10 | 80% | 40% |
| **mọi xe** | 807 | 43,7% | **80,5%** |

Tính cả box sai trục (mọi xe, 1007 box): hướng lệch < 20° (đủ 360°) **35,1% → 64,5%** (xe con 36,1% → 67,6%).
Đã thử và bỏ: cho mô hình đổi luôn trục 90° khi nó thấy trục vuông góc hợp hơn R lần (`eval_end.py --axis`, R = 1,5…5):
xe con chỉ +0,5 điểm (67,6 → 68,1%), R = 0 còn kém hơn (65,0%) → trục vẫn lấy theo LiDAR. Ví dụ cảnh 0061 frame 0:
xe tải chỉ thấy mặt sau thùng → box nằm ngang 90°, đây là lỗi trục (mục 6.1), không phải đầu/đuôi.
Khớp JS ↔ Python: cùng ảnh, logit onnxruntime-web vs PyTorch lệch ≤ 1,5e-5, 16/16 cùng quyết định
(`tests/heading.test.js` kiểm hình học alpha / lật / khung cắt). Lật 180° giữ nguyên 8 góc box nghiêng (dốc / nghiêng đổi dấu).
Bản đóng gói (`extension/models/heading.onnx`, 6 MB) học lại trên cả 10 cảnh; số trên là của bản 8 cảnh.
Trong extension: box tự động (T / Shift+T) và box vẽ tay đều được chỉnh đầu/đuôi; khung duyệt ghi "đầu/đuôi theo ảnh"
và "(không chắc, kiểm tra)" khi hai hướng gần bằng nhau. Xe đạp / buýt còn ít ảnh học → số chưa chắc.

### 4.A Tự động (extension 0.14.0): mô hình 2D khoanh vật → box 3D, không có người (08/10/2026)

**Đầu vào:** 10 cảnh nuScenes-mini (keyframe), mỗi frame × 6 camera. Mô hình YOLOX (COCO, Apache 2.0, ONNX chính thức),
chạy bằng onnxruntime-web (cùng `extension/detect.js` với extension; ảnh co về ô vuông bằng OpenCV — so với trình duyệt
trên cùng ảnh: cùng vật, toạ độ lệch 1–2 px, điểm lệch 0,01–0,04). Mỗi khung (điểm ≥ ngưỡng) → `fitFromRect` (nhãn
theo lớp của mô hình). Box của một vật thấy ở nhiều camera gộp làm một (`BF.sameObject`: mặt bằng chồng nhau
BEV IoU > 0,1 hoặc tâm < 1 m), giữ điểm cao nhất.
**Đáp án:** vật có box nuScenes thuộc 6 lớp, ≥ 10 điểm LiDAR, tâm nằm trong ít nhất một camera (car 2828, truck 495,
bus 243, motorcycle 151, bicycle 35, pedestrian 1190).
**Ghép:** theo điểm giảm dần, box tool ghép với vật đáp án chưa ghép gần nhất trong 2 m (tâm, nhìn từ trên), bất kể lớp.
Box gần vật < 10 điểm: bỏ qua (không tính đúng / sai).
**Chỉ số:** tìm được = % vật đáp án có box ghép; đúng lớp; lệch tâm / góc / 3D IoU của box tìm được; IoU ≥ 0,5 / 0,7 tính
trên MỌI vật; tỉ lệ đúng = box ghép vật thật / (box ghép vật thật + box không ghép được); thời gian mỗi ảnh.
**Chạy:** `node tools/public/eval_auto.js <cảnh> --model <onnx> --score 0.2 --json out.json` →
`node tools/public/auto_summary.js out-*.json` (bảng theo ngưỡng 0,2 / 0,3 / 0,4 / 0,5).

Ngưỡng 0,3 (dùng trong extension):

| Mô hình | xe con tìm được | xe con IoU ≥ 0,5 | xe tải | xe buýt | xe máy | người đi bộ | box đúng | ms / ảnh |
|---|---|---|---|---|---|---|---|---|
| YOLOX-Tiny (416) | 73% | 36% | 46% | 46% | 36% | 67% | 77% | ~180 |
| **YOLOX-S (640) — đóng gói** | **79%** | **43%** | **58%** | **53%** | **54%** | **75%** | 76% | ~700 |

YOLOX-S, xe con theo khoảng cách: < 20 m tìm được 86% (IoU ≥ 0,5: 52%), 20–40 m 71% (32%), > 40 m 34%.
Box tìm được (S): xe con lệch tâm 0,41 m, góc 2,3°, 3D IoU 0,53; xe buýt 3D IoU 0,68; người đi bộ lệch tâm 0,14 m.
Lớp đoán đúng: xe con 96%, người 99%, xe tải 77%, xe máy 73%.

Gộp box giữa các camera (lần 1: chỉ tâm < 1 m → lần 2: thêm mặt bằng chồng nhau): box sai giảm 1302 → 1003 (Tiny,
ngưỡng 0,3), tỉ lệ đúng 70% → 77%, số vật tìm được gần như giữ nguyên (cảnh 0061: 151 → 117 box sai).
Box sai còn lại (lần 1, Tiny): đặt lệch sang vật khác 2–5 m 29%, trùng một vật 24% + 22%, không có vật được gán nhãn
gần đó 20% (xe đỗ xa / vật ngoài 6 lớp).

Trong extension (CVAT giả lập `tools/dev/mock_cvat.py`, cảnh 0061): Shift+T 6 camera ≈ 4,6 s (S), duyệt / lưu tất cả
ghi đúng cuboid vào CVAT, vật đã có box không bị đề xuất lại.

### 4.0 Mới nhất — extension 0.13.0, đủ 10 cảnh nuScenes-mini (08/10/2026)
Cảnh: 0061 0103 0553 0655 0757 0796 0916 1077 1094 1100 (keyframe), khung ±3 px, calib đáp án, không bù thời gian.

| Lớp | n | tạo được | đạt | lệch tâm p50 | góc p50 | BEV IoU p50 | 3D IoU p50 | 3D IoU ≥ 0,5 | 3D IoU ≥ 0,7 |
|---|---|---|---|---|---|---|---|---|---|
| xe con | 2283 | 98% | 36% | 0,38 m | 2,4° | 0,68 | 0,62 | 60% | 31% |
| xe tải / công trình | 345 | 98% | 12% | 1,23 m | 2,3° | 0,46 | 0,39 | 40% | 14% |
| xe buýt | 199 | 97% | 20% | 0,96 m | 1,3° | 0,68 | 0,59 | 59% | 28% |
| xe máy | 141 | 99% | 20% | 0,33 m | 9,2° | 0,40 | 0,37 | 30% | 4% |
| xe đạp | 33 | 97% | 9% | 0,43 m | 9,0° | 0,35 | 0,33 | 9% | 3% |
| người đi bộ | 1141 | 100% | 1% | 0,24 m | — | 0,41 | 0,38 | 24% | 1% |

Xe con theo cảnh (đạt / 3D IoU ≥ 0,7): 0061 51/50% · 0103 33/27% · 0553 24/18% · 0655 33/28% · 0757 35/23% ·
0796 41/41% · 0916 31/28% · 1077 38/29% · 1094 44/39% · 1100 52/50%.
Lỗi xe con: đạt 36% · gần đúng 31% · lấy nhầm vật 14% · xoay sai > 30° 8% · ngắn 6% · dính xe bên 2% · không tạo 2%.

Thay đổi 0.13.0 so với bản trước: thử thêm hướng xoay 90° khi cụm < 40 điểm (chỉ xe dài ≥ 3 m), chọn nếu khớp khung
rõ hơn 0,03 IoU → xe con đạt 35 → 36%, xoay sai 9 → 8%; xe máy / xe đạp không đổi (áp cho chúng thì kém đi 2–3%).
Ngưỡng đã quét: cụm < 0 / 40 / 80 / mọi cỡ × chênh 0 / 0,03 / 0,08 → khác nhau ≤ 1%; chọn bản ít tác dụng phụ nhất
(dính xe bên không tăng). Kết luận: với luật hình học, khung 2D cho rất ít thông tin về hướng xe.

**Mức trần của cách hình học:** xe con ~36% đạt / 31% 3D IoU ≥ 0,7. Mốc tham khảo: Frustum PointNets (mô hình học,
cùng bài toán, khung 2D đáp án) báo 3D AP xe con ≈ 74% ở IoU 0,7 trên KITTI (LiDAR 64 tia, dày hơn nuScenes).

### 4.1 Theo phiên bản code (gộp 4 cảnh: 1326 xe con, 247 xe tải/công trình, 344 người đi bộ)

| Phiên bản | Lớp | tạo được | đạt | lấy nhầm vật | lệch tâm p50 | BEV IoU p50 | 3D IoU p50 |
|---|---|---|---|---|---|---|---|
| gốc (commit 5481f00) | xe con | 92% | 28% | 22% | 0,56 m | 0,60 | 0,53 |
| + nối vòng quét theo chiều đứng (6c68d78) | xe con | 94% | 30% | 19% | 0,48 m | 0,64 | 0,55 |
| **+ khoảng nối tự chỉnh theo mật độ điểm** (hiện tại) | xe con | **98%** | **34%** | **15%** | **0,42 m** | **0,66** | **0,60** |
| gốc | xe tải | 83% | 10% | 19% | 1,32 m | 0,46 | 0,40 |
| hiện tại | xe tải | 99% | 12% | 16% | 1,11 m | 0,54 | 0,43 |
| gốc | người đi bộ | 92% | 1% | 18% | 0,30 m | 0,35 | 0,32 |
| hiện tại | người đi bộ | 100% | 1% | 17% | 0,29 m | 0,36 | 0,32 |

(Góc của người đi bộ không có nghĩa — gần vuông — nên "đạt" luôn thấp; xem lệch tâm.)

### 4.2 Theo cảnh (phiên bản hiện tại, xe con)

| Cảnh | n | tạo được | lệch tâm p50 / p90 | góc p50 | BEV IoU | đạt | Ghi chú |
|---|---|---|---|---|---|---|---|
| 0061 đường phố | 105 | 96% | 0,27 / 3,2 m | 1,2° | 0,76 | 51% | dưới 20 m: 71% đạt, IoU 0,81 |
| 0655 bãi đỗ | 490 | 99% | 0,46 / 3,3 m | 3,2° | 0,65 | 32% | xe đỗ sát nhau, che nhau |
| 0916 bãi đỗ | 517 | 98% | 0,47 / 6,8 m | 2,6° | 0,62 | 30% | 20–40 m: 19% đạt |
| 1077 đêm | 214 | 95% | 0,36 / 2,9 m | 1,4° | 0,69 | 38% | LiDAR không phụ thuộc ánh sáng |

Xe con **thấy rõ (bị che < 20%)**, cảnh 0061: lệch tâm 0,14 m, góc 1,0°, IoU 0,82.

### 4.3 Phân loại lỗi xe con (hiện tại, 4 cảnh)
đạt 34% · gần đúng 31% · **lấy nhầm vật 15%** · **xoay sai > 30° 10%** · ngắn quá 6% · không tạo được 2% · dính xe bên 2%.
- Lấy nhầm vật: 83% trường hợp là lấy **vật ở gần hơn** (vật che). Trước khi sửa, 152/255 ca điểm của xe đúng có trong
  khung nhưng bị bỏ ở bước gom cụm (LiDAR thưa → xe vỡ thành mảnh < 8 điểm), 103/255 có cụm đúng nhưng chọn sai.
- Xoay sai: kích thước đúng nhưng box nằm vuông góc — thường là xe chỉ thấy đầu/đuôi.

### 4.4 Calib cần chuẩn tới đâu (cảnh 0061, xe con, phiên bản 6c68d78)
Khung vẽ vẫn từ đáp án, tool dùng calib bị làm lệch đều mọi camera:

| Calib lệch | 0 | 0,25° / 5 cm | 0,5° / 10 cm | 1° / 20 cm | 2° / 40 cm | autocalib |
|---|---|---|---|---|---|---|
| đạt | 54% | 53% | 52% | 40% | 17% | 45% |
| BEV IoU p50 | 0,75 | 0,75 | 0,75 | 0,68 | 0,44 | 0,73 |

→ Yêu cầu: calib sai **≤ ~0,5° và ≤ 10 cm**.

### 4.5 Benchmark giả lập (rig tổng hợp) (`tests/boxfit.bench.js`, 60 xe/camera) — để chắc sửa không làm hỏng
| | cam trước all | cam trước bị che | cam phải all | cam phải bị che | thưa (DROP=1) F / R |
|---|---|---|---|---|---|
| gốc (IoU3D ≥ 0,7) | 85% | 76% | 87% | 73% | 43% / 43% |
| hiện tại | 87% | 82% | 87% | 73% | 43% / 45% |

### 4.6 Đã thử và bỏ (kèm số)
| Thử | Kết quả xe con 4 cảnh (đạt / nhầm vật) | Vì sao bỏ |
|---|---|---|
| Chọn cụm bằng "dựng thử box rồi chiếu lại" (có lấp khung) | 26% / 18% | bản lấp khung làm cụm nào cũng khớp |
| Như trên, không lấp khung | 29–32% / 14–18% | không hơn cách chọn cũ |
| Khoảng nối ngang tăng theo khoảng cách (0,012–0,018 × r) | 31–33% / 16–17% | kém hơn khoảng nối cố định lớn |
| Khoảng nối cố định 0,6 m, cụm ≥ 5 điểm | 36% / 12% | tốt nhất trên nuScenes nhưng **làm hỏng dữ liệu dày**: benchmark cam trước bị che 82% → 71% |
| Hạ ngưỡng cụm còn 3–5 điểm (khoảng nối 0,35) | 30–31% / 16–17% | ít tác dụng |
| Bù thời gian camera–LiDAR khi dựng box (`--time`) | như không bù | vật chủ yếu đứng yên, khung lấy điểm vốn rộng |

Chọn cuối: **khoảng nối = 2,5 × khoảng cách trung vị giữa các điểm gần nhau trong khung, kẹp 0,35–0,7 m; cụm ≥ 5
điểm khi khoảng nối > 0,35** — dữ liệu dày giữ nguyên như cũ, dữ liệu thưa tự nới.

### 4.7 Phép chiếu (T1, cảnh 0061)
Camera chụp cùng lúc LiDAR (BACK_LEFT, Δt ≈ 0): **0,30 px**. Các camera khác lệch 2–19 px do chụp lệch 10–43 ms khi
xe chạy 4–9 m/s; bù thời gian → 0,2–1,7 px.

---

## 5. Giới hạn của cách đo
- Khung 2D là **giả lập** (hình chiếu box đáp án ±3 px, bao cả phần bị che). Người thật có thể vẽ theo phần nhìn thấy
  → cần đo thêm trên CVAT local với người vẽ thật.
- Dùng **calib đáp án**; với calib của xe mình sai số thật phụ thuộc mục 4.4.
- nuScenes: LiDAR 32 tia (thưa hơn xe mình), không có fisheye, chỉ keyframe 2 Hz.
- 4 cảnh trong 10 cảnh của bản mini.

## 6. Việc tiếp theo
0. Đầu/đuôi: thêm ảnh xe tải / buýt / xe đạp (nuScenes trainval hoặc KITTI) để học thêm; đo trên CVAT local với người vẽ thật.
1. Xoay sai 90° khi chỉ thấy đầu/đuôi xe (10%).
2. Lấy nhầm vật che còn 15%.
3. Xe tải / xe công trình: box dài bị cắt ngắn hoặc dính xe bên (đạt 12%).
4. Đo với người vẽ thật trên CVAT local (`upload.zip` của từng cảnh).
