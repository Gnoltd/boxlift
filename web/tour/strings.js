/* Tour + footer copy for the web demo. */
(function (root, factory) {
  const v = factory();
  if (typeof module === 'object' && module.exports) module.exports = v; else root.TourStrings = v;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    vi: {
      stepOf: 'Bước {n}/{total}',
      step0Title: 'Xem đám mây điểm LiDAR', step0Body: 'Kéo chuột để xoay, cuộn để phóng to cảnh LiDAR của nuScenes scene-0061. Xong thì bấm "Tiếp".',
      step1Title: 'Vẽ một hộp 3D', step1Body: 'Chọn công cụ vẽ hộp rồi kéo trên ảnh hoặc đám mây điểm để tạo một hộp 3D. Tour tự sang bước sau khi hộp xuất hiện.',
      step2Title: 'Căn hộp tự động', step2Body: 'Chọn hộp rồi nhấn phím T: mô hình sẽ tự căn khít hộp vào vật thể. Hoặc bấm "Tiếp" để bỏ qua.',
      step3Title: 'Theo dõi qua các khung hình', step3Body: 'Chọn hộp rồi nhấn Shift+K để tạo track và để công cụ nội suy hộp sang các khung kế tiếp. Hoặc bấm "Tiếp".',
      next: 'Tiếp', skip: 'Bỏ qua', restartTour: 'Làm lại hướng dẫn', resetDemo: 'Đặt lại demo', hide: 'Ẩn',
      resetConfirm: 'Xoá mọi hộp và cài đặt đã lưu trong trình duyệt này, rồi tải lại?',
      doneTitle: 'Bạn có thể tự do thử', doneBody: 'Hết hướng dẫn. Dữ liệu chỉ lưu trong trình duyệt của bạn.',
      footer: 'Dữ liệu: nuScenes (Motional), CC BY-NC-SA 4.0. Mô hình dùng cho mục đích phi thương mại theo giấy phép của từng mô hình. Đây là bản demo miễn phí, phi thương mại.',
      repoLabel: 'Mã nguồn trên GitHub', repoUrl: 'https://github.com/Gnoltd/boxlift'
    },
    en: {
      stepOf: 'Step {n}/{total}',
      step0Title: 'Look at the LiDAR point cloud', step0Body: 'Drag to rotate and scroll to zoom the nuScenes scene-0061 LiDAR view. Press "Next" when done.',
      step1Title: 'Draw a 3D box', step1Body: 'Pick the box tool and drag on the image or the point cloud to create a 3D box. The tour moves on once the box appears.',
      step2Title: 'Auto-fit the box', step2Body: 'Select the box and press T: the model snaps the box tightly onto the object. Or press "Next" to skip.',
      step3Title: 'Track across frames', step3Body: 'Select the box and press Shift+K to create a track and let the tool interpolate it to the next frames. Or press "Next".',
      next: 'Next', skip: 'Skip', restartTour: 'Restart tour', resetDemo: 'Reset demo', hide: 'Hide',
      resetConfirm: 'Delete all boxes and settings saved in this browser, then reload?',
      doneTitle: 'Free to explore', doneBody: 'Tour finished. Your work is stored only in this browser.',
      footer: 'Data: nuScenes (Motional), CC BY-NC-SA 4.0. Models are for non-commercial use under each model\'s licence. This is a free, non-commercial demo.',
      repoLabel: 'Source on GitHub', repoUrl: 'https://github.com/Gnoltd/boxlift'
    }
  };
});
