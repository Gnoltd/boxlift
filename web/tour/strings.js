/* Spotlight tour + credits copy for the web demo. Keys <view>Title / <view>Body follow Tour.view keys. */
(function (root, factory) {
  const v = factory();
  if (typeof module === 'object' && module.exports) module.exports = v; else root.TourStrings = v;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    vi: {
      stepOf: 'Bước {n}/{total}',
      sceneTitle: 'Màn hình 3D', sceneBody: 'Đây là đám mây điểm LiDAR của một frame. Kéo chuột để xoay, cuộn để phóng to, chuột phải để kéo ngang.',
      sceneBehindTitle: 'Màn hình 3D ở phía sau', sceneBehindBody: 'Đám mây điểm LiDAR nằm sau cửa sổ BoxLift. Bấm ✕ (hoặc Esc) để đóng BoxLift và xem (nếu được hỏi, chọn "Lưu phiên và thoát"), hoặc bấm "Tiếp" để bỏ qua.',
      openTitle: 'Mở BoxLift', openBody: 'Bấm "Mở BoxLift" để dán nhãn trên ảnh camera.',
      cameraTitle: 'LiDAR chiếu lên ảnh', cameraBody: 'Các chấm màu là điểm LiDAR chiếu lên ảnh. Đổi camera bằng phím 1-7 hoặc các tab. Phím H đổi kiểu hiển thị.',
      boxTitle: 'Vẽ một box', boxBody: 'Nhấn N, kéo một khung 2D quanh một chiếc xe, rồi nhấn Enter để lưu. Box 3D hiện ngay ở 3 góc nhìn cạnh.',
      autoTitle: 'Để máy đề xuất box', autoBody: 'Box vừa lưu cũng đã hiện trên màn hình 3D phía sau. Nhấn T để máy tự đề xuất box (lần đầu tải mô hình AI, xem chip ở góc trên bên phải; nếu chưa thấy gì, đợi chip báo xong rồi nhấn T lại). Enter để lưu, X để bỏ.',
      trackTitle: 'Bám xe qua các frame', trackBody: 'Chọn một box đã lưu trong danh sách bên phải trước, rồi nhấn Shift+K để box bám xe qua 10 frame. D / F để chuyển frame.',
      doneTitle: 'Bạn có thể tự do thử', doneBody: 'Đây là sandbox: thử mọi công cụ, dữ liệu chỉ lưu trong trình duyệt của bạn. Bấm "Làm lại hướng dẫn" để xem lại từ đầu hoặc "Đặt lại demo" để xoá hết box đã vẽ.',
      next: 'Tiếp', skip: 'Bỏ qua', restartTour: 'Làm lại hướng dẫn', resetDemo: 'Đặt lại demo', hide: 'Ẩn',
      resetConfirm: 'Xoá mọi box và cài đặt đã lưu trong trình duyệt này, rồi tải lại?',
      footer: 'Dữ liệu: Argoverse 2 Sensor Dataset (CC BY-NC-SA 4.0). Mô hình: YOLOX (Apache 2.0); MTrans, Frustum PointNet và mô hình hướng xe huấn luyện trên dữ liệu CC BY-NC-SA nên chỉ dùng phi thương mại. Màn hình 3D: three.js (MIT). Đây là bản demo miễn phí, phi thương mại.',
      creditsToggle: 'Giấy phép', noticeLabel: 'Chi tiết dữ liệu', noticeUrl: '/demo-data/NOTICE.md',
      repoLabel: 'Mã nguồn trên GitHub', repoUrl: 'https://github.com/Gnoltd/boxlift'
    },
    en: {
      stepOf: 'Step {n}/{total}',
      sceneTitle: '3D screen', sceneBody: 'This is the LiDAR point cloud of one frame. Drag to rotate, scroll the wheel to zoom, right-drag to pan.',
      sceneBehindTitle: 'The 3D screen is behind', sceneBehindBody: 'The LiDAR point cloud sits behind the BoxLift window. Press ✕ (or Esc) to close BoxLift and see it (if asked, choose "Save session and leave"), or press "Next" to skip.',
      openTitle: 'Open BoxLift', openBody: 'Press "Open BoxLift" to label on the camera images.',
      cameraTitle: 'LiDAR projected on the image', cameraBody: 'The coloured dots are LiDAR points projected onto the image. Switch camera with keys 1-7 or the tabs. H changes the display mode.',
      boxTitle: 'Draw a box', boxBody: 'Press N, drag a 2D box around a vehicle, then press Enter to save. The 3D box shows up in the 3 side views right away.',
      autoTitle: 'Let the machine propose boxes', autoBody: 'The box you saved now also shows on the 3D screen behind. Press T to let the machine propose boxes (the first run downloads AI models: see the chip at the top right; if nothing happens, wait until it says ready, then press T again). Enter saves, X drops.',
      trackTitle: 'Follow a vehicle across frames', trackBody: 'First select a saved box in the list on the right, then press Shift+K to make it follow the vehicle across the 10 frames. D / F change frame.',
      doneTitle: 'Free to explore', doneBody: 'This is a sandbox: try every tool, your work is stored only in this browser. Press "Restart tour" to see the tour again or "Reset demo" to delete all drawn boxes.',
      next: 'Next', skip: 'Skip', restartTour: 'Restart tour', resetDemo: 'Reset demo', hide: 'Hide',
      resetConfirm: 'Delete all boxes and settings saved in this browser, then reload?',
      footer: 'Data: Argoverse 2 Sensor Dataset (CC BY-NC-SA 4.0). Models: YOLOX (Apache 2.0); MTrans, Frustum PointNet and the vehicle-heading model are trained on CC BY-NC-SA data, so non-commercial use only. 3D screen: three.js (MIT). This is a free, non-commercial demo.',
      creditsToggle: 'Licence', noticeLabel: 'Data details', noticeUrl: '/demo-data/NOTICE.md',
      repoLabel: 'Source on GitHub', repoUrl: 'https://github.com/Gnoltd/boxlift'
    }
  };
});
