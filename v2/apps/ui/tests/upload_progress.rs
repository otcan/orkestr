use orkestr_v2_ui::upload_progress::{UploadPhase, UploadProgress};
#[test]
fn acknowledged_bytes_and_readiness_are_distinct() {
    let mut p = UploadProgress {
        phase: UploadPhase::Uploading,
        file_name: "file.bin".into(),
        file_index: 1,
        file_count: 1,
        completed_bytes: 500_000_000,
        total_bytes: 1_000_000_000,
    };
    assert!(p.is_valid());
    assert_eq!(p.percent(), 50);
    p.phase = UploadPhase::Ready;
    assert!(!p.is_valid());
    p.completed_bytes = p.total_bytes;
    p.phase = UploadPhase::PreparingAttachment;
    assert!(p.is_valid());
    assert_eq!(p.percent(), 100);
    assert!(p.label().contains("preparing attachment"));
    p.completed_bytes += 1;
    assert!(!p.is_valid());
    p.completed_bytes = 0;
    p.file_count = 0;
    assert!(!p.is_valid());
}
