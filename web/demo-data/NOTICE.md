# Data notice / Thông báo về dữ liệu

## Source / Nguồn

The sample data in this folder comes from the **Argoverse 2 Sensor Dataset**, log `av2-20dd185d`
(https://www.argoverse.org/av2.html). Wilson et al., "Argoverse 2: Next Generation Datasets for Self-Driving Perception and Forecasting", NeurIPS Datasets and Benchmarks 2021.

Dữ liệu mẫu trong thư mục này lấy từ **Argoverse 2 Sensor Dataset**, log `av2-20dd185d`.

## Licence / Giấy phép

[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (CC BY-NC-SA 4.0)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

## Changes made / Thay đổi đã thực hiện

- 10 of the 100 frames of the log were selected (the consecutive window 17 to 26). / Chọn 10 trong 100 frame của log.
- The camera images were repacked into `.ctx` archives (one per frame) so the page can serve them as CVAT context images. / Ảnh camera được đóng lại thành các tệp `.ctx`.
- Point clouds (`.pcd`) are unchanged. / Point cloud giữ nguyên.
- Calibration was copied without annotations; no ground-truth boxes are included. / Calib được sao chép, không kèm nhãn.

## Use / Sử dụng

This demo is free and non-commercial. The AI models it can download are trained on CC BY-NC-SA data (nuScenes, KITTI) and are for non-commercial use as well; see `extension/THIRD_PARTY.md` in the repository for each model's licence.

Bản demo này miễn phí và phi thương mại. Các mô hình AI huấn luyện trên dữ liệu CC BY-NC-SA nên chỉ dùng phi thương mại.

## Software / Phần mềm

The 3D point-cloud screen of the demo uses **three.js** 0.185.1 (MIT licence, © three.js authors, https://threejs.org), served from this site (`/vendor/three/`, see `web/vendor/three/README.md` in the repository).

Màn hình đám mây điểm 3D của demo dùng **three.js** 0.185.1 (giấy phép MIT).
