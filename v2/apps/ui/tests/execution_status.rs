use orkestr_v2_contracts::ExecutionStatus;
use orkestr_v2_ui::execution::Execution;
fn wire() -> ExecutionStatus {
    serde_json::from_value(serde_json::json!({
        "schema_version":1,"conversation_id":"00000000-0000-4000-8000-000000000003",
        "run_id":"00000000-0000-4000-8000-000000000005", "revision":10,
        "observed_at_ms":9000000,"phase":"running","queue_age_ms":null,
        "progress":null,"resources":{"cpu_capacity_permille":255,"resident_bytes":1048576,"observed_at_ms":8999999},
        "capabilities":{"stop":true,"steer":true}
    })).unwrap()
}
#[test]
fn canonical_scope_revision_survives_new_run_and_return_navigation() {
    let mut state = Execution::default();
    let status = wire();
    let conversation = status.conversation_id.to_string();
    let generation = state.select(&conversation, "");
    state.apply_status(generation, 100, status.clone()).unwrap();
    assert!(state.resources(100).contains("25.5%"));
    assert!(state.can_stop(100000)); // model silence does not revoke cancel authority
    let mut next = status.clone();
    next.run_id = Some(
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000006")).unwrap(),
    );
    next.revision = 11;
    next.observed_at_ms = 9000001;
    state.apply_status(generation, 101, next.clone()).unwrap();
    assert!(state.apply_status(generation, 102, status.clone()).is_err());
    state.select("other-conversation", "");
    let returned = state.select(&conversation, "");
    assert!(state.apply_status(generation, 103, next.clone()).is_err());
    assert!(state.apply_status(returned, 103, status).is_err());
    state.apply_status(returned, 103, next).unwrap();
    assert!(state.fresh(103));
}
#[test]
fn validator_missing_run_old_resources_and_progress_reference_fail_honestly() {
    let mut state = Execution::default();
    let status = wire();
    let generation = state.select(&status.conversation_id.to_string(), "");
    for i in 0..4 {
        let mut bad = status.clone();
        match i {
            0 => bad.schema_version = 2,
            1 => bad.resources.as_mut().unwrap().cpu_capacity_permille = 1001,
            2 => bad.run_id = None,
            _ => bad.revision = -1,
        }
        assert!(state.apply_status(generation, 1, bad).is_err());
        assert!(!state.can_stop(1));
    }
    let mut queued = status.clone();
    queued.phase = orkestr_v2_contracts::ExecutionPhase::Queued;
    queued.run_id = None;
    state.apply_status(generation, 2, queued).unwrap();
    assert!(!state.can_stop(2) && !state.can_steer(2));
    let mut old_resources = status;
    old_resources.revision = 11;
    old_resources.resources.as_mut().unwrap().observed_at_ms = 1;
    old_resources.progress = Some(serde_json::from_value(serde_json::json!({"payload_id":"00000000-0000-4000-8000-000000000007","observed_at_ms":9000000})).unwrap());
    state
        .apply_status(generation, 3, old_resources.clone())
        .unwrap();
    assert!(state.resources(3).contains("unavailable"));
    assert!(state.summary(3).contains("Update available"));
    assert!(!state.summary(3).contains("2/10"));
    // Same snapshot is replayable; changing data at the same revision is not.
    state
        .apply_status(generation, 4, old_resources.clone())
        .unwrap();
    old_resources.capabilities.stop = false;
    assert!(state.apply_status(generation, 5, old_resources).is_err());
}

#[test]
fn awaiting_acceptance_blocked_and_missing_telemetry_are_not_completion() {
    use orkestr_v2_contracts::ExecutionPhase;
    for phase in [
        ExecutionPhase::AwaitingAcceptance,
        ExecutionPhase::Blocked,
        ExecutionPhase::CancelRequested,
    ] {
        let mut state = Execution::default();
        let mut status = wire();
        status.phase = phase;
        status.resources = None;
        status.progress = None;
        let generation = state.select(&status.conversation_id.to_string(), "");
        state.apply_status(generation, 1, status).unwrap();
        assert!(!state.can_stop(1));
        assert!(!state.can_steer(1));
        assert!(!state.summary(1).contains("Completed"));
        assert!(state.resources(1).contains("unavailable"));
        assert!(!state.resources(1).contains("0%"));
    }
}
