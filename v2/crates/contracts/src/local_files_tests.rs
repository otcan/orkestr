use super::*;

fn request(operation: LocalFileOperation) -> LocalFileRequestCreate {
    LocalFileRequestCreate {
        request_key: "k-1".into(),
        operation,
        path: None,
        paths: vec![],
        content_base64: None,
        timeout_ms: None,
    }
}

#[test]
fn paths_stay_inside_the_folder() {
    for ok in [
        "a",
        "a/b.txt",
        "notes/2026/plan.md",
        "with space/ü.txt",
        ".hidden",
    ] {
        assert!(local_file_path(ok, false), "{ok}");
    }
    for bad in [
        "",
        "/",
        "/etc/passwd",
        "a/",
        "a//b",
        "..",
        "../x",
        "a/../b",
        "./a",
        "a/.",
        "a\\b",
        "C:\\x",
        "a\u{0}b",
        "a\nb",
    ] {
        assert!(!local_file_path(bad, false), "{bad:?}");
    }
    assert!(local_file_path("", true));
    let deep = vec!["d"; LOCAL_FILE_DEPTH_MAX + 1].join("/");
    assert!(!local_file_path(&deep, false));
    let long = "n".repeat(LOCAL_FILE_NAME_MAX + 1);
    assert!(!local_file_path(&long, false));
    assert_eq!(local_file_name("a/b/c.txt"), "c.txt");
}

#[test]
fn request_shapes_match_their_operation() {
    let mut list = request(LocalFileOperation::List);
    assert!(!list.is_valid(), "a listing names a directory");
    list.path = Some(String::new());
    assert!(list.is_valid());
    let mut read = request(LocalFileOperation::Read);
    read.path = Some(String::new());
    assert!(!read.is_valid(), "the folder itself is not a file");
    read.path = Some("a/../../b".into());
    assert!(!read.is_valid());
    read.path = Some("a/b".into());
    assert!(read.is_valid());
    read.content_base64 = Some("aGk=".into());
    assert!(!read.is_valid(), "only a write carries content");
    let mut hash = request(LocalFileOperation::Hash);
    assert!(!hash.is_valid());
    hash.paths = vec!["a".into(), "a".into()];
    assert!(!hash.is_valid(), "duplicates");
    hash.paths = (0..=LOCAL_FILE_PATHS_MAX)
        .map(|i| format!("f{i}"))
        .collect();
    assert!(!hash.is_valid(), "too many");
    hash.paths.truncate(LOCAL_FILE_PATHS_MAX);
    assert!(hash.is_valid());
    let mut write = request(LocalFileOperation::Write);
    write.path = Some("out.txt".into());
    assert!(!write.is_valid(), "a write needs content");
    write.content_base64 = Some("aGk=".into());
    assert!(write.is_valid());
    write.content_base64 = Some("A".repeat(LOCAL_FILE_WRITE_MAX.div_ceil(3) * 4 + 4));
    assert!(!write.is_valid(), "content over 1 MiB");
    let mut timed = read.clone();
    timed.content_base64 = None;
    timed.timeout_ms = Some(LOCAL_FILE_TIMEOUT_MAX_MS + 1);
    assert!(!timed.is_valid());
    timed.timeout_ms = Some(LOCAL_FILE_TIMEOUT_MIN_MS);
    assert!(timed.is_valid());
    timed.request_key = "bad key".into();
    assert!(!timed.is_valid());
}

#[test]
fn requests_never_name_a_conversation() {
    let body = r#"{"request_key":"k","operation":"list","path":"","conversation_id":"00000000-0000-4000-8000-000000000001"}"#;
    assert!(serde_json::from_str::<LocalFileRequestCreate>(body).is_err());
}

#[test]
fn failures_use_the_closed_browser_codes() {
    let mut finish = LocalFileFinish {
        connection_id: Uuid::new_v4(),
        outcome: LocalFileOutcome::Failed,
        error: Some("not_found".into()),
        listing: None,
        hashes: None,
        written: None,
        upload_id: None,
        empty: false,
        files: vec![],
        last_modified_ms: None,
    };
    assert!(finish.error_valid());
    finish.error = Some("anything else".into());
    assert!(!finish.error_valid());
    finish.outcome = LocalFileOutcome::Done;
    assert!(!finish.error_valid());
    finish.error = None;
    assert!(finish.error_valid());
}
