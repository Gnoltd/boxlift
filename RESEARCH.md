# Research cho calib-overlay — đã dùng, sẽ thử, nhật ký cho report

Đi kèm [`PLAN.md`](PLAN.md). Số trong ngoặc (1.4, 4.5…) là tính năng trong PLAN.md. Gồm 3 phần:
- **Phần 1:** phương pháp, mô hình, dữ liệu **đã dùng** trong extension 0.19.0.
- **Phần 2:** nghiên cứu **sẽ thử** cho từng vấn đề trong plan.
- **Phần 3:** nhật ký thử nghiệm.

Thử xong thì ghi vào nhật ký ở cuối file, kể cả khi **không** thành công. Report cần cả hai loại.

> DOI đã đối chiếu với Crossref, link GitHub đã kiểm tra còn truy cập được (12/10/2026). Bài chỉ có trên arXiv thì ghi DOI
> arXiv (`10.48550/arXiv.<id>`). "—" nghĩa là không có, hoặc chưa tìm thấy code chính thức. Trước khi trích số liệu vào
> report, mở bản PDF để kiểm lại.

---

## Phần 1. Đã dùng trong extension 0.19.0

### 1.1 Mô hình học

| Thành phần | Nghiên cứu | DOI | Source code | Dùng ở đâu, làm gì |
|---|---|---|---|---|
| Detector 2D (T / Shift+T) | Ge và cộng sự, *YOLOX: Exceeding YOLO Series in 2021*, arXiv 2021 | [10.48550/arXiv.2107.08430](https://doi.org/10.48550/arXiv.2107.08430) | [Megvii-BaseDetection/YOLOX](https://github.com/Megvii-BaseDetection/YOLOX) (Apache 2.0) | `models/yolox_s.onnx`, `detect.js`. Bản YOLOX-S học trên COCO, ONNX chính thức |
| Box 3D cho xe con | Liu và cộng sự, *Multimodal Transformer for Automatic 3D Annotation and Object Detection* (MTrans), ECCV 2022 | [10.1007/978-3-031-19839-7_38](https://doi.org/10.1007/978-3-031-19839-7_38) | [Cliu2/MTrans](https://github.com/Cliu2/MTrans) (MPL-2.0) | `models/mtrans.onnx`, `mtrans.js`. Đội train lại: KITTI rồi học tiếp 60.000 xe nuScenes. Tái tạo trên KITTI đạt recall IoU ≥ 0,7 là 80,2% (bài báo 81,2%) |
| Box 3D cho xe tải / buýt / xe đạp / người | Qi và cộng sự, *Frustum PointNets for 3D Object Detection from RGB-D Data*, CVPR 2018 | [10.1109/CVPR.2018.00102](https://doi.org/10.1109/CVPR.2018.00102) | [charlesq34/frustum-pointnets](https://github.com/charlesq34/frustum-pointnets) | `models/frustum_seg.onnx` + `frustum_box.onnx`, `frustum.js`. Đội tự viết lại bản nhẹ (`tools/frustum/`), train từ đầu |
| Đầu / đuôi xe từ ảnh | Mousavian và cộng sự, *3D Bounding Box Estimation Using Deep Learning and Geometry*, CVPR 2017: dự đoán góc quan sát α theo bin | [10.1109/CVPR.2017.597](https://doi.org/10.1109/CVPR.2017.597) | — | `models/heading.onnx`, `heading.js`. 8 bin góc α, giữ hướng mà mô hình cho là đúng hơn |
| Backbone của mô hình đầu / đuôi | Howard và cộng sự, *Searching for MobileNetV3*, ICCV 2019 | [10.1109/ICCV.2019.00140](https://doi.org/10.1109/ICCV.2019.00140) | [pytorch/vision](https://github.com/pytorch/vision) (weights `MobileNet_V3_Small_Weights.IMAGENET1K_V1`) | `tools/heading/`. Fine-tune trên ảnh cắt từ nuScenes-mini |

### 1.2 Thuật toán hình học / tối ưu (nhánh hình học, lan box, calib)

| Thành phần | Nghiên cứu | DOI | Source code | Dùng ở đâu |
|---|---|---|---|---|
| Mặt đất cục bộ | Fischler & Bolles, *Random Sample Consensus*, Commun. ACM 1981 | [10.1145/358669.358692](https://doi.org/10.1145/358669.358692) | — (tự viết) | `boxfit.js` `fitGround` |
| Hướng xe từ điểm LiDAR | Zhang, Xu, Dong, Dolan, *Efficient L-shape Fitting for Vehicle Detection Using Laser Scanners*, IEEE IV 2017 (tiêu chí closeness) | [10.1109/IVS.2017.7995698](https://doi.org/10.1109/IVS.2017.7995698) | — (tự viết) | `boxfit.js` (bước 5) |
| Bù chuyển động xe giữa 2 frame | Besl & McKay, *A Method for Registration of 3-D Shapes* (ICP), IEEE TPAMI 1992 | [10.1109/34.121791](https://doi.org/10.1109/34.121791) | — (tự viết, ICP 2D) | `propagate.js` (bước 1) |
| Giải calib từ cặp điểm | Marquardt, *An Algorithm for Least-Squares Estimation of Nonlinear Parameters*, SIAM J. Appl. Math. 1963 (Levenberg–Marquardt) | [10.1137/0111030](https://doi.org/10.1137/0111030) | — (tự viết) | `pairs.js` |
| Chống click sai khi giải calib | Huber, *Robust Estimation of a Location Parameter*, Ann. Math. Statist. 1964 | [10.1214/aoms/1177703732](https://doi.org/10.1214/aoms/1177703732) | — (tự viết) | `pairs.js` (trọng số Huber) |
| Mô hình camera fisheye | Kannala & Brandt, *A Generic Camera Model and Calibration Method for Conventional, Wide-Angle, and Fish-Eye Lenses*, IEEE TPAMI 2006 | [10.1109/TPAMI.2006.153](https://doi.org/10.1109/TPAMI.2006.153) | [opencv/opencv](https://github.com/opencv/opencv) (`cv2.fisheye`) | `projection.js`, `camera.py` |
| Mô hình camera thường | Brown–Conrady (méo xuyên tâm + tiếp tuyến), như `cv2.projectPoints` | — | [opencv/opencv](https://github.com/opencv/opencv) | `projection.js`, `camera.py` |
| Gom cụm điểm | Gom cụm Euclid trên lưới 3D (cách làm phổ biến, như `EuclideanClusterExtraction` của PCL) | — | [PointCloudLibrary/pcl](https://github.com/PointCloudLibrary/pcl) | `boxfit.js` (bước 3) |

### 1.3 Dữ liệu, nền tảng, thư viện

| Thành phần | Nguồn | DOI | Source code / trang | Ghi chú |
|---|---|---|---|---|
| nuScenes | Caesar và cộng sự, *nuScenes: A Multimodal Dataset for Autonomous Driving*, CVPR 2020 | [10.1109/CVPR42600.2020.01164](https://doi.org/10.1109/CVPR42600.2020.01164) | [nutonomy/nuscenes-devkit](https://github.com/nutonomy/nuscenes-devkit) | CC BY-NC-SA 4.0. Train và đo; cảnh 0103, 0916 giữ riêng để đo |
| KITTI | Geiger, Lenz, Urtasun, *Are we ready for autonomous driving? The KITTI vision benchmark suite*, CVPR 2012 | [10.1109/CVPR.2012.6248074](https://doi.org/10.1109/CVPR.2012.6248074) | https://www.cvlibs.net/datasets/kitti/ | CC BY-NC-SA 3.0 |
| KITTI raw (calib, sweep) | Geiger và cộng sự, *Vision meets robotics: The KITTI dataset*, IJRR 2013 | [10.1177/0278364913491297](https://doi.org/10.1177/0278364913491297) | như trên | Calib `2011_09_26` |
| CVAT | Công cụ gán nhãn | — | [cvat-ai/cvat](https://github.com/cvat-ai/cvat) | Extension chạy trên CVAT, lưu cuboid qua API |
| ONNX Runtime Web 1.30.0 | Microsoft | — | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) (MIT) | `extension/ort/`. Chạy mô hình bằng WebGPU, dự phòng WASM |

Giấy phép chi tiết: [`extension/THIRD_PARTY.md`](extension/THIRD_PARTY.md). Các mô hình học trên dữ liệu CC BY-NC-SA nên
**chỉ được dùng phi thương mại**.

---

## Phần 2. Sẽ thử

### R3. Tự tinh chỉnh calib từ file mẫu (PLAN.md: 1.4, 3.7, 4.7)

Hướng này gọi là **targetless calibration**: không cần bảng caro, tinh chỉnh từ dữ liệu chạy đường. Survey của Li và cộng
sự chia làm 4 nhóm: dựa trên lý thuyết thông tin, dựa trên đặc trưng, dựa trên chuyển động (ego-motion), và dựa trên học.

| Nghiên cứu | DOI | Source code | Ý chính | Lấy gì về thử | Hợp extension? |
|---|---|---|---|---|---|
| Li và cộng sự, *Automatic targetless LiDAR–camera calibration: a survey*, Artif. Intell. Rev. 2022 | [10.1007/s10462-022-10317-y](https://doi.org/10.1007/s10462-022-10317-y) | — | Tổng quan, chia 4 nhóm phương pháp | Phần tổng quan cho report | — |
| Levinson & Thrun, *Automatic Online Calibration of Cameras and Lasers*, RSS 2013 | [10.15607/RSS.2013.IX.029](https://doi.org/10.15607/RSS.2013.IX.029) | — | Cạnh trong ảnh ứng với chỗ độ sâu LiDAR đổi đột ngột; tối ưu để hai loại cạnh trùng nhau. Tự chạy, chạy online | Hàm điểm "căn cạnh": cạnh ảnh × điểm LiDAR ở biên độ sâu, tìm 7 tham số của `pairs.js` | **Cao.** Nhẹ, chạy JS được |
| Koide và cộng sự, *General, Single-shot, Target-less, and Automatic LiDAR-Camera Extrinsic Calibration Toolbox*, ICRA 2023 | [10.1109/ICRA48891.2023.10160691](https://doi.org/10.1109/ICRA48891.2023.10160691) | [koide3/direct_visual_lidar_calibration](https://github.com/koide3/direct_visual_lidar_calibration) | Ước lượng ban đầu bằng SuperGlue + RANSAC, rồi tinh chỉnh bằng NID. Hỗ trợ camera fisheye | Chạy tool gốc **offline** làm đáp án; bước NID làm phép đo thứ hai | Trung bình (offline) |
| Luo, Yan, Li, *Calib-Anything*, arXiv 2023 | [10.48550/arXiv.2306.02656](https://doi.org/10.48550/arXiv.2306.02656) | [OpenCalib/CalibAnything](https://github.com/OpenCalib/CalibAnything) | Dùng mask của SAM; điểm chiếu vào cùng mask phải nhất quán. Không cần train. Cần intensity LiDAR | Dùng mask / box YOLOX tin cậy cao làm vùng | Thấp trong trình duyệt; offline được |
| Park và cộng sự, *Spatiotemporal Camera-LiDAR Calibration: A Targetless and Structureless Approach*, IEEE RA-L 2020 | [10.1109/LRA.2020.2969164](https://doi.org/10.1109/LRA.2020.2969164) | — | Hiệu chỉnh **cả lệch thời gian** lẫn vị trí | Ý tưởng cho tinh chỉnh `time_offset_s` (sau demo) | Tham khảo |

**Đề xuất thử theo thứ tự:**
1. **R3-a, căn cạnh (Levinson):** cộng điểm trên 8 frame, tìm thô (lưới ±2°) rồi tinh chỉnh bằng LM của `pairs.js`.
2. **R3-b, cặp từ box:** đáy và tâm cụm LiDAR của xe đỗ so với box 2D có confidence ≥ 0,8, làm cặp cho `pairs.js`.
3. **Đáp án:** 20 cặp click tay, cùng với kết quả tool Koide chạy offline.

**Đo:** sai số chiếu trung vị (px) trên 20 cặp click tay, cho từng camera, với 3 bản: file mẫu / tự chỉnh / chỉnh tay. Đo
thêm thời gian chạy và số camera bị cơ chế an toàn từ chối.

### R4. Bỏ sót xe nhỏ / xa (PLAN.md: 4.3, 4.4, 4.5)

| Nghiên cứu | DOI | Source code | Ý chính | Lấy gì về thử |
|---|---|---|---|---|
| Akyon, Altinuc, Temizel, *Slicing Aided Hyper Inference and Fine-Tuning for Small Object Detection* (SAHI), ICIP 2022 | [10.1109/ICIP46576.2022.9897990](https://doi.org/10.1109/ICIP46576.2022.9897990) | [obss/sahi](https://github.com/obss/sahi) | Cắt ảnh thành ô chồng nhau, chạy detector trên từng ô và cả ảnh, rồi gộp. Không cần train lại | YOLOX-S trên 2–4 ô cho camera độ phân giải cao, gộp bằng NMS |
| Zhang và cộng sự, *Faraway-Frustum: Dealing with Lidar Sparsity for 3D Object Detection using Fusion*, ITSC 2021 | [10.1109/ITSC48978.2021.9564990](https://doi.org/10.1109/ITSC48978.2021.9564990) | [dongfang-steven-yang/faraway-frustum](https://github.com/dongfang-steven-yang/faraway-frustum) | Vật xa có rất ít điểm; xử lý riêng, chiếu theo mask | Nhánh riêng cho xe xa ít điểm (đi cùng ngưỡng số điểm ở 4.2) |

**Đề xuất thử:** R4-a hạ ngưỡng (0,3 → 0,15) · R4-b SAHI 2×2 ô · R4-c đề xuất từ cụm LiDAR không có box 2D. Mỗi cách đo
recall và số box sai trên bộ ca lỗi.

### R5. Hai xe sát nhau bị gộp / lẫn điểm vật cạnh (PLAN.md: 4.6)

| Nghiên cứu | DOI | Source code | Ý chính | Lấy gì về thử |
|---|---|---|---|---|
| Weng & Kitani, *Monocular 3D Object Detection with Pseudo-LiDAR Point Cloud*, ICCV Workshops 2019 | [10.1109/ICCVW.2019.00114](https://doi.org/10.1109/ICCVW.2019.00114) | [xinshuoweng/Mono3DPLiDAR](https://github.com/xinshuoweng/Mono3DPLiDAR) | Cắt frustum theo **mask** thay cho box 2D: bỏ được điểm nền và điểm thừa | Thay frustum hình hộp bằng frustum theo mask |
| Faraway-Frustum (như R4) | [10.1109/ITSC48978.2021.9564990](https://doi.org/10.1109/ITSC48978.2021.9564990) | như R4 | Chiếu theo mask ngữ nghĩa, loại điểm của vật che và nền | Như trên |
| *VESPA: Towards un(Human)supervised Open-World Pointcloud Labeling for Autonomous Driving*, arXiv 2025 | [10.48550/arXiv.2507.20397](https://doi.org/10.48550/arXiv.2507.20397) | — | Chiếu LiDAR vào mask SAM; LiDAR đặt cao hơn camera nên vẫn lẫn điểm bị che, lọc bằng **DBSCAN trên mặt phẳng XY** | DBSCAN theo XY trong frustum để tách 2 xe (đúng 4.6) |
| Li và cộng sự, *Segment, Lift and Fit: Automatic 3D Shape Labeling from 2D Prompts* (SLF), ECCV 2024 | [10.1007/978-3-031-72907-2_24](https://doi.org/10.1007/978-3-031-72907-2_24) | — | Prompt 2D → mask SAM → dựng hình 3D; tối ưu để hình chiếu khớp mask và bề mặt khớp điểm LiDAR | Kiểm tra sau khi dựng: hình chiếu cuboid phải khớp mask |
| Wei và cộng sự, *FGR: Frustum-Aware Geometric Reasoning for Weakly Supervised 3D Vehicle Detection*, ICRA 2021 | [10.1109/ICRA48506.2021.9561245](https://doi.org/10.1109/ICRA48506.2021.9561245) | [weiyithu/FGR](https://github.com/weiyithu/FGR) | Dựng box xe từ box 2D + LiDAR bằng suy luận hình học trong frustum | So sánh với nhánh hình học hiện tại |

**Đề xuất thử:**
- R5-a: DBSCAN theo XY trong frustum, kèm kiểm tra kích thước (4.6). Rẻ, không cần mô hình mới.
- R5-b: mask thay box. Cần mô hình segment nhẹ (YOLO-seg hoặc MobileSAM). Đo tốc độ trên trình duyệt trước khi làm sâu.

### R6. Lan box qua frame và lưu track (sau demo)

| Nghiên cứu | DOI | Source code | Ý chính | Lấy gì về thử |
|---|---|---|---|---|
| Qi và cộng sự, *Offboard 3D Object Detection from Point Cloud Sequences* (3D Auto Labeling), CVPR 2021 | [10.1109/CVPR46437.2021.00607](https://doi.org/10.1109/CVPR46437.2021.00607) | — | Detect nhiều frame, theo dõi, rồi tinh chỉnh box theo từng vật trên toàn track. Báo chất lượng ngang nhãn người (Waymo) | Khi lưu Track: gộp điểm của cùng xe qua nhiều frame để dựng **một kích thước cố định** cho cả track |
| Ma và cộng sự, *DetZero: Rethinking Offboard 3D Object Detection with Long-term Sequential Point Clouds*, ICCV 2023 | [10.1109/ICCV51070.2023.00620](https://doi.org/10.1109/ICCV51070.2023.00620) | [PJLab-ADG/DetZero](https://github.com/PJLab-ADG/DetZero) | Offboard dài hạn, đứng đầu bảng Waymo | Tham khảo cho report |

**Đề xuất thử:** R6-a kích thước cố định theo track (trung vị qua các frame). Đo độ lệch kích thước giữa các frame của
cùng một xe, trước / sau.

---

## Phần 3. Nhật ký thử nghiệm

Ghi mỗi lần thử một dòng, **cả lần không thành công**. Lưu kèm commit, dữ liệu và lệnh chạy để tái lập khi viết report.
Số đo chi tiết vẫn ghi ở [`tools/public/NHAT-KY-DO.md`](tools/public/NHAT-KY-DO.md); bảng này là tóm tắt.

### Đã làm (tóm tắt từ `NHAT-KY-DO.md` và nhật ký tuần 04)

| Ngày | Mã | Thử gì | Dữ liệu | Trước | Sau | Kết luận |
|---|---|---|---|---|---|---|
| 10/2026 | KQ-1 | Hình học (v0.16) → Frustum PointNet (v0.18) | nuScenes 0103 + 0916, 1026 xe mọi loại | IoU3D ≥ 0,7: 25,8% | 42,9% | ✅ dùng |
| 10/10/2026 | KQ-2 | Tái tạo MTrans trên KITTI | KITTI val | — | Recall IoU ≥ 0,7: 80,2% (bài báo 81,2%) | ✅ tái tạo được |
| 10/2026 | KQ-3 | MTrans chỉ học KITTI, chạy trên nuScenes | nuScenes 0103 + 0916 | — | 32,9% | ❌ lệch miền, phải học thêm |
| 10/2026 | KQ-4 | MTrans học tiếp 60.000 xe nuScenes (≈10 giờ GPU) | 812 xe con 0103 + 0916 | Frustum: 47,3% | 78,8% | ✅ dùng (v0.19) |
| 11/10/2026 | KQ-5 | Tích hợp MTrans vào extension (WebGPU) | 827 xe con 0103 + 0916 | 0.18: 46,4% | 0.19: 73,5%, ~70 ms / xe | ✅ dùng |

### Sẽ thử

| Ngày | Mã | Thử gì | Dữ liệu (job / cảnh, số ca) | Trước | Sau | Thời gian chạy | Kết luận | Commit |
|---|---|---|---|---|---|---|---|---|
| | R3-a | | | | | | ✅ dùng / ❌ bỏ / 🔁 thử tiếp | |

Tiêu chí "thành công", chốt trước khi thử:
- **R3:** sai số chiếu giảm ≥ 30% so với file mẫu, không camera nào tệ hơn.
- **R4:** recall trên bộ ca lỗi tăng, số box sai tăng không quá 10%, mỗi camera chậm thêm không quá 0,3 s.
- **R5:** số ca "2 xe thành 1" giảm ≥ 50%, IoU 3D trên nuScenes 0103 / 0916 không giảm.
- **R6:** độ lệch kích thước của cùng xe giữa các frame giảm.
