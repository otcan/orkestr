use orkestr_v2_ui::upload_progress::{is_upload_id, UploadPhase, UploadProgress};
#[test]
fn acknowledged_bytes_and_readiness_are_distinct() {
    let mut p = UploadProgress {
        phase: UploadPhase::Uploading,
        upload_id: None,
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

#[test]
fn cancel_is_offered_only_while_a_named_upload_is_unfinished() {
    let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    let mut p: UploadProgress = serde_json::from_value(serde_json::json!({
        "phase": "uploading", "upload_id": id, "file_name": "large.bin",
        "file_index": 1, "file_count": 2, "completed_bytes": 1, "total_bytes": 9,
    }))
    .unwrap();
    assert!(p.is_valid());
    for phase in [
        UploadPhase::Preparing,
        UploadPhase::Checking,
        UploadPhase::Encrypting,
        UploadPhase::Uploading,
        UploadPhase::Finalizing,
        UploadPhase::PreparingAttachment,
    ] {
        p.phase = phase;
        assert_eq!(p.cancellable(), Some(id), "{phase:?}");
    }
    // A finished file is removed from its chip; a failed one is resumed.
    for phase in [
        UploadPhase::FileReady,
        UploadPhase::Ready,
        UploadPhase::Failed,
    ] {
        p.phase = phase;
        assert_eq!(p.cancellable(), None, "{phase:?}");
    }
    p.phase = UploadPhase::Uploading;
    p.upload_id = None;
    assert_eq!(p.cancellable(), None, "nothing to name, nothing to cancel");
    for bad in [
        "",
        "00000000-0000-0000-0000-000000000000",
        "0F8FAD5B-D9CB-469F-A165-70867728950E",
        "0f8fad5b-d9cb-469f-a165-70867728950e'",
        "0f8fad5bd9cb469fa16570867728950e0000",
    ] {
        assert!(!is_upload_id(bad), "{bad}");
        p.upload_id = Some(bad.into());
        assert!(!p.is_valid(), "{bad}");
    }
    assert!(is_upload_id(id));
}
