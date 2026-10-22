use super::*;

fn home() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("deploy-drain-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    dir
}

#[test]
fn unbound_drain_is_inert() {
    let drain = DeployDrain::default();
    assert!(!drain.poll());
    assert!(!drain.is_draining());
    assert!(!drain.status().drained);
}

#[test]
fn startup_removes_a_stale_request_so_drain_never_survives_a_restart() {
    let dir = home();
    std::fs::write(dir.join(REQUEST_FILE), b"").unwrap();
    std::fs::write(dir.join(STATUS_FILE), b"{}").unwrap();
    let drain = DeployDrain::default();
    drain.bind(&dir);
    assert!(!dir.join(REQUEST_FILE).exists());
    assert!(!dir.join(STATUS_FILE).exists());
    assert!(!drain.poll());
    assert!(!drain.is_draining());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn request_file_pauses_and_its_removal_resumes() {
    let dir = home();
    let drain = DeployDrain::default();
    drain.bind(&dir);
    std::fs::write(dir.join(REQUEST_FILE), b"").unwrap();
    assert!(drain.poll());
    assert!(drain.is_draining());
    assert!(!drain.poll(), "no change while the request stays");
    // Unknown until the window runtime observes Core: never "drained".
    let status = drain.status();
    assert!(status.draining && !status.drained);
    assert_eq!(status.unresolved_windows, -1);
    drain.observe(Some(2), Some(1));
    assert!(!drain.status().drained);
    drain.observe(Some(0), Some(3));
    let status = drain.status();
    assert!(status.drained);
    assert_eq!(status.queued_intents, 3);
    assert!(status.since_ms > 0);
    drain.write_status();
    let written: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join(STATUS_FILE)).unwrap()).unwrap();
    assert_eq!(written["drained"], true);
    assert_eq!(written["pid"], std::process::id());
    std::fs::remove_file(dir.join(REQUEST_FILE)).unwrap();
    assert!(drain.poll());
    assert!(!drain.is_draining());
    let status = drain.status();
    assert!(!status.draining && !status.drained);
    std::fs::remove_dir_all(dir).unwrap();
}
