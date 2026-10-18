/* Tour + footer copy for the web demo. */
(function (root, factory) {
  const v = factory();
  if (typeof module === 'object' && module.exports) module.exports = v; else root.TourStrings = v;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    vi: {
      stepOf: 'Bước {n}/{total}',
      step0Title: 'Xem LiDAR chiếu lên ảnh', step0Body: 'Các chấm màu trên ảnh camera là điểm LiDAR được chiếu lên ảnh. Đổi camera bằng phím 1-7 hoặc các tab. Phím H đổi kiểu hiển thị điểm (không phải bật/tắt). Xem xong thì bấm "Tiếp".',
      step1Title: 'Vẽ một hộp 3D', step1Body: 'Nhấn N để bật chế độ Vẽ box, rồi kéo một khung 2D quanh một chiếc xe. Kiểm tra hộp 3D và 3 góc nhìn cạnh, rồi nhấn Enter để lưu.',
      step2Title: 'Để máy đề xuất hộp', step2Body: 'Nhấn T để máy đề xuất hộp (lần đầu phải tải mô hình AI, xem nhãn ở góc trên bên phải). Enter để lưu hộp đề xuất, X để bỏ.',
      step3Title: 'Theo dõi qua các khung hình', step3Body: 'Chọn hộp đã lưu rồi nhấn Shift+K để theo dõi nó qua các khung hình. Dùng D / F để về khung trước / sang khung sau.',
      next: 'Tiếp', skip: 'Bỏ qua', restartTour: 'Làm lại hướng dẫn', resetDemo: 'Đặt lại demo', hide: 'Ẩn',
      resetConfirm: 'Xoá mọi hộp và cài đặt đã lưu trong trình duyệt này, rồi tải lại?',
      doneTitle: 'Bạn có thể tự do thử', doneBody: 'Hết hướng dẫn, bạn có thể thử tự do mọi công cụ. Dữ liệu chỉ lưu trong trình duyệt của bạn. Bấm "Làm lại hướng dẫn" để xem lại từ đầu hoặc "Đặt lại demo" để xoá hết hộp đã vẽ.',
      footer: 'Dữ liệu: Argoverse 2 Sensor Dataset (CC BY-NC-SA 4.0). Mô hình: YOLOX (Apache 2.0); MTrans, Frustum PointNet và mô hình hướng xe huấn luyện trên dữ liệu CC BY-NC-SA nên chỉ dùng phi thương mại. Đây là bản demo miễn phí, phi thương mại.',
      creditsToggle: 'Giấy phép', noticeLabel: 'Chi tiết dữ liệu', noticeUrl: '/demo-data/NOTICE.md',
      repoLabel: 'Mã nguồn trên GitHub', repoUrl: 'https://github.com/Gnoltd/boxlift'
    },
    en: {
      stepOf: 'Step {n}/{total}',
      step0Title: 'LiDAR projected on the image', step0Body: 'The coloured dots on the camera image are LiDAR points projected onto it. Switch camera with keys 1-7 or the tabs. H cycles the point display mode (it is not an on/off toggle). When you are done, press "Next".',
      step1Title: 'Draw a 3D box', step1Body: 'Press N to turn on Draw box mode, then drag a 2D box around a vehicle. Check the 3D box and the 3 side views, then press Enter to save.',
      step2Title: 'Let the machine propose boxes', step2Body: 'Press T to let the machine propose boxes (the first run downloads AI models: see the chip at the top right). Enter saves a proposal, X drops it.',
      step3Title: 'Track across frames', step3Body: 'Select a saved box and press Shift+K to track it across frames. Use D / F for the previous / next frame.',
      next: 'Next', skip: 'Skip', restartTour: 'Restart tour', resetDemo: 'Reset demo', hide: 'Hide',
      resetConfirm: 'Delete all boxes and settings saved in this browser, then reload?',
      doneTitle: 'Free to explore', doneBody: 'Tour finished: feel free to try every tool. Your work is stored only in this browser. Press "Restart tour" to see it again or "Reset demo" to delete all drawn boxes.',
      footer: 'Data: Argoverse 2 Sensor Dataset (CC BY-NC-SA 4.0). Models: YOLOX (Apache 2.0); MTrans, Frustum PointNet and the vehicle-heading model are trained on CC BY-NC-SA data, so non-commercial use only. This is a free, non-commercial demo.',
      creditsToggle: 'Licence', noticeLabel: 'Data details', noticeUrl: '/demo-data/NOTICE.md',
      repoLabel: 'Source on GitHub', repoUrl: 'https://github.com/Gnoltd/boxlift'
    }
  };
});
