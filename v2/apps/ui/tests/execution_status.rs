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
    old_resources.resources.as_mut().unwrap().resident_bytes += 1;
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

#[test]
fn absent_status_clears_controls_but_preserves_revision_and_generation_fence() {
    let mut state = Execution::default();
    let status = wire();
    let generation = state.select(&status.conversation_id.to_string(), "");
    state.apply_status(generation, 100, status.clone()).unwrap();
    assert!(!state.absent(generation + 1));
    assert!(state.can_stop(100));
    assert!(state.absent(generation));
    assert!(!state.can_stop(100));
    assert!(state.resources(100).contains("unavailable"));
    let mut regressing = status.clone();
    regressing.revision -= 1;
    assert!(state.apply_status(generation, 101, regressing).is_err());
    state.apply_status(generation, 102, status).unwrap();
    assert!(state.fresh(102));
}

#[test]
fn sampled_clock_advances_without_revision_but_identical_replay_never_refreshes() {
    let mut state = Execution::default();
    let mut status = wire();
    let generation = state.select(&status.conversation_id.to_string(), "");
    state.apply_status(generation, 100, status.clone()).unwrap();
    state
        .apply_status(generation, 60100, status.clone())
        .unwrap();
    assert!(!state.fresh(60100));
    assert!(state.resources(60100).contains("unavailable"));
    assert!(state.can_stop(60100));
    status.observed_at_ms += 60000;
    status.queue_age_ms = Some(60000);
    state
        .apply_status(generation, 60101, status.clone())
        .unwrap();
    assert!(state.fresh(60101));
    assert!(state.resources(60101).contains("unavailable"));
    let mut older_sample = status.clone();
    older_sample.observed_at_ms -= 60000;
    older_sample.queue_age_ms = None;
    state
        .apply_status(generation, 120102, older_sample)
        .unwrap();
    assert!(!state.fresh(120102));
    assert!(state.resources(120102).contains("unavailable"));
    assert!(state.can_stop(120102));
    status.capabilities.stop = false;
    state
        .apply_status(generation, 120103, status.clone())
        .unwrap();
    assert!(!state.can_stop(120103));
    assert!(!state.fresh(120103));
    status.phase = orkestr_v2_contracts::ExecutionPhase::Starting;
    assert!(state.apply_status(generation, 120104, status).is_err());
}

#[test]
fn owner_scoped_model_survives_component_selection_remount_without_rejuvenation() {
    let mut owner_model = Execution::default();
    let status = wire();
    let id = status.conversation_id.to_string();
    let first_mount = owner_model.select(&id, "");
    owner_model
        .apply_status(first_mount, 1, status.clone())
        .unwrap();
    let second_mount = owner_model.select(&id, "");
    assert!(owner_model.summary(60001).contains("unavailable"));
    assert!(owner_model
        .apply_status(first_mount, 60001, status.clone())
        .is_err());
    owner_model
        .apply_status(second_mount, 60001, status.clone())
        .unwrap();
    assert!(!owner_model.fresh(60001));
    assert!(owner_model.resources(60001).contains("unavailable"));
    let mut backwards = status.clone();
    backwards.revision -= 1;
    assert!(owner_model
        .apply_status(second_mount, 60002, backwards.clone())
        .is_err());
    owner_model.authorization_lost();
    let new_owner_mount = owner_model.select(&id, "");
    owner_model
        .apply_status(new_owner_mount, 60003, backwards)
        .unwrap();
}

#[test]
fn absent_then_identical_old_status_keeps_resources_stale() {
    let mut state = Execution::default();
    let mut status = wire();
    let generation = state.select(&status.conversation_id.to_string(), "");
    state.apply_status(generation, 1, status.clone()).unwrap();
    assert!(state.absent(generation));
    state
        .apply_status(generation, 60002, status.clone())
        .unwrap();
    assert!(!state.fresh(60002));
    assert!(state.resources(60002).contains("unavailable"));
    assert!(state.can_stop(60002));
    status.observed_at_ms += 60001;
    state.apply_status(generation, 60003, status).unwrap();
    assert!(state.fresh(60003));
    assert!(state.resources(60003).contains("unavailable"));
}

#[test]
fn separate_fast_retention_does_not_replace_deep_or_inherit_its_high_water() {
    let mut deep = Execution::default();
    let mut fast = Execution::default();
    let original = wire();
    let conversation = original.conversation_id.to_string();
    let deep_generation = deep.select(&conversation, "");
    deep.apply_status(deep_generation, 100, original.clone())
        .unwrap();
    let mut fast_status = original.clone();
    fast_status.run_id = Some(
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000008")).unwrap(),
    );
    fast_status.revision = 2;
    let fast_generation = fast.select(&conversation, "");
    fast.apply_status(fast_generation, 101, fast_status.clone())
        .unwrap();
    assert_eq!(deep.control_status().unwrap().run_id, original.run_id);
    assert_eq!(fast.control_status().unwrap().run_id, fast_status.run_id);
    let remounted = fast.select(&conversation, "");
    assert!(fast
        .apply_status(fast_generation, 102, fast_status.clone())
        .is_err());
    fast.apply_status(remounted, 102, fast_status.clone())
        .unwrap();
    fast.authorization_lost();
    deep.authorization_lost();
    assert!(fast.control_status().is_none());
    assert!(deep.control_status().is_none());
    assert!(fast.apply_status(remounted, 103, fast_status).is_err());
}
