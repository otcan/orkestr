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

#[test]
fn predicate_metadata_is_bounded_and_cannot_decide_the_drain() {
    let drain = DeployDrain::default();
    drain.set(true);
    drain.observe(Some(1), Some(3));
    let conversation = orkestr_v2_contracts::ConversationId(uuid::Uuid::new_v4());
    let mut diagnostic = DrainWindowDiagnostic::new(conversation);
    diagnostic.local_roles_ready = Some(true);
    diagnostic.core_switch_ready = Some(false);
    diagnostic.outcome = DrainWindowOutcome::CoreSwitchNotReady;
    drain.observe_diagnostics(vec![diagnostic; 65]);
    let status = drain.status();
    assert!(
        !status.drained,
        "metadata never declares an unresolved window drained"
    );
    assert_eq!(status.diagnostics.total, 65);
    assert_eq!(status.diagnostics.windows.len(), 64);
    assert!(status.diagnostics.observed_ms > 0);
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(
        json["diagnostics"]["windows"][0]["outcome"],
        "core_switch_not_ready"
    );
    assert_eq!(
        json["diagnostics"]["windows"][0]["core_switch_ready"],
        false
    );
    // Existing gate remains solely the existing authenticated unresolved count.
    drain.observe(Some(0), Some(3));
    assert!(drain.status().drained);
    drain.set(false);
    assert_eq!(drain.status().diagnostics, DrainDiagnostics::default());
}

#[test]
fn unobserved_core_predicate_stays_unknown_and_resets_between_requests() {
    let drain = DeployDrain::default();
    drain.set(true);
    let mut diagnostic =
        DrainWindowDiagnostic::new(orkestr_v2_contracts::ConversationId(uuid::Uuid::new_v4()));
    diagnostic.local_roles_ready = Some(false);
    diagnostic.outcome = DrainWindowOutcome::LocalRolesNotReady;
    drain.observe_diagnostics(vec![diagnostic]);
    let json = serde_json::to_value(drain.status()).unwrap();
    assert!(json["diagnostics"]["windows"][0]["core_switch_ready"].is_null());
    assert!(
        !drain.status().drained,
        "unknown Core count remains unknown"
    );
    drain.set(false);
    drain.set(true);
    assert_eq!(drain.status().diagnostics, DrainDiagnostics::default());
}
