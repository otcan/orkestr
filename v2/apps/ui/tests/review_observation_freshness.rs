//! Independent regressions for observation freshness and durable revision semantics.
use orkestr_v2_contracts::ExecutionStatus;
use orkestr_v2_ui::execution::Execution;

fn status() -> ExecutionStatus {
    serde_json::from_value(serde_json::json!({
        "schema_version": 1,
        "conversation_id": "00000000-0000-4000-8000-000000000003",
        "run_id": "00000000-0000-4000-8000-000000000005",
        "revision": 10,
        "observed_at_ms": 100000,
        "phase": "running",
        "queue_age_ms": null,
        "progress": null,
        "resources": {
            "cpu_capacity_permille": 255,
            "resident_bytes": 1048576,
            "observed_at_ms": 100000
        },
        "capabilities": {"stop": true, "steer": true}
    }))
    .unwrap()
}

#[test]
fn healthy_read_can_advance_observation_without_a_durable_revision_change() {
    let mut state = Execution::default();
    let mut first = status();
    first.resources = None;
    first.phase = orkestr_v2_contracts::ExecutionPhase::Queued;
    first.run_id = None;
    first.queue_age_ms = Some(1000);
    first.capabilities.stop = false;
    first.capabilities.steer = false;
    let generation = state.select(&first.conversation_id.to_string(), "");
    state.apply_status(generation, 1, first.clone()).unwrap();
    // Core 76393bd2 advances read time / queue age without updating durable revision.
    first.observed_at_ms += 1000;
    first.queue_age_ms = Some(2000);
    assert!(
        state.apply_status(generation, 1001, first).is_ok(),
        "a successful same-state Core read must refresh status"
    );
}

#[test]
fn identical_replay_cannot_rejuvenate_the_same_old_resource_observation() {
    let mut state = Execution::default();
    let first = status();
    let generation = state.select(&first.conversation_id.to_string(), "");
    state.apply_status(generation, 1, first.clone()).unwrap();
    assert!(state.resources(1).contains("25.5%"));
    assert!(state.resources(60001).contains("unavailable"));
    // No new server/resource observation was supplied during the minute of silence.
    state.apply_status(generation, 60001, first).unwrap();
    assert!(
        state.resources(60001).contains("unavailable"),
        "replayed old telemetry must stay unavailable: {}",
        state.resources(60001)
    );
    assert!(
        state.can_stop(60001),
        "stale telemetry must not revoke stop authority"
    );
}
