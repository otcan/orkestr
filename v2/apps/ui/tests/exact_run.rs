use orkestr_v2_contracts::ExecutionStatus;
use orkestr_v2_ui::execution::Execution;
fn status(run: u8, revision: i64) -> ExecutionStatus {
    serde_json::from_value(serde_json::json!({"schema_version":1,
        "conversation_id":"00000000-0000-4000-8000-000000000003",
        "run_id":format!("00000000-0000-4000-8000-{run:012}"),
        "revision":revision,"control_revision":2,"observed_at_ms":1000,
        "phase":"running","capabilities":{"stop":true,"steer":false}}))
    .unwrap()
}
#[test]
fn exact_worker_selection_refuses_sibling_and_retains_independent_high_watermark() {
    let mut model = Execution::default();
    let worker = status(5, 10);
    let conversation = worker.conversation_id.to_string();
    let run = worker.run_id.as_ref().unwrap().to_string();
    let generation = model.select(&conversation, &run);
    assert!(model.apply_status(generation, 1, status(6, 11)).is_err());
    assert!(model.control_status().is_none());
    model.apply_status(generation, 2, worker.clone()).unwrap();
    let pending = model.stops.prepare(&worker, "worker-stop".into()).unwrap();
    let sibling = status(6, 20);
    let sibling_run = sibling.run_id.as_ref().unwrap().to_string();
    let other = model.select(&conversation, &sibling_run);
    model.apply_status(other, 3, sibling).unwrap();
    assert!(model.apply_status(generation, 4, worker.clone()).is_err());
    let returned = model.select(&conversation, &run);
    assert!(model.apply_status(returned, 5, status(5, 9)).is_err());
    model.apply_status(returned, 6, worker.clone()).unwrap();
    assert_eq!(model.control_status().unwrap().run_id, worker.run_id);
    let retry = model.stops.prepare(&worker, "unused".into()).unwrap();
    assert_eq!(
        serde_json::to_value(pending.request).unwrap(),
        serde_json::to_value(retry.request).unwrap()
    );
    model.authorization_lost();
    let fresh = model.select(&conversation, &run);
    model.apply_status(fresh, 7, status(5, 1)).unwrap();
    assert!(!model.stops.retryable(&worker));
}
#[test]
fn ordinary_latest_deep_selection_can_change_runs_without_becoming_exact_selection() {
    let mut model = Execution::default();
    let first = status(5, 10);
    let g = model.select(&first.conversation_id.to_string(), "");
    model.apply_status(g, 1, first).unwrap();
    model.apply_status(g, 2, status(6, 11)).unwrap();
    assert_eq!(model.control_status().unwrap().run_id, status(6, 11).run_id);
}

#[test]
fn sampled_capabilities_can_change_without_rejuvenating_equal_revision_telemetry() {
    let mut model = Execution::default();
    let mut wire = status(5, 10);
    let g = model.select(
        &wire.conversation_id.to_string(),
        &wire.run_id.as_ref().unwrap().to_string(),
    );
    model.apply_status(g, 1, wire.clone()).unwrap();
    assert!(model.can_stop(60000));
    wire.capabilities.stop = false;
    model.apply_status(g, 60000, wire.clone()).unwrap();
    assert!(!model.can_stop(60000));
    assert!(!model.fresh(60000));
    wire.capabilities.stop = true;
    model.apply_status(g, 60001, wire.clone()).unwrap();
    assert!(model.can_stop(60001));
    assert!(!model.fresh(60001));
    wire.observed_at_ms += 10;
    wire.capabilities.stop = false;
    model.apply_status(g, 60002, wire.clone()).unwrap();
    assert!(!model.can_stop(60002));
    let mut reordered = wire.clone();
    reordered.observed_at_ms -= 1;
    reordered.capabilities.stop = true;
    reordered.phase = orkestr_v2_contracts::ExecutionPhase::Starting;
    model.apply_status(g, 60003, reordered).unwrap();
    assert!(!model.can_stop(60003));
    for changed in 0..4 {
        let mut bad = wire.clone();
        bad.capabilities.stop = true;
        match changed {
            0 => bad.control_revision = Some(3),
            1 => bad.phase = orkestr_v2_contracts::ExecutionPhase::Starting,
            2 => bad.progress = serde_json::from_value(serde_json::json!({"payload_id":"00000000-0000-4000-8000-000000000099","observed_at_ms":1000})).unwrap(),
            _ => bad.capabilities.steer = true,
        }
        assert!(model.apply_status(g, 60004, bad).is_err());
        assert!(!model.can_stop(60004));
    }
    // A monotonic receive regression must not resurrect the registry slot.
    wire.capabilities.stop = true;
    assert!(model.apply_status(g, 0, wire.clone()).is_err());
    model.authorization_lost();
    assert!(model.apply_status(g, 60005, wire).is_err());
}

#[test]
fn equal_time_availability_on_remount_preserves_original_telemetry_anchor() {
    let mut model = Execution::default();
    let mut wire = status(5, 10);
    let conversation = wire.conversation_id.to_string();
    let run = wire.run_id.as_ref().unwrap().to_string();
    let first = model.select(&conversation, &run);
    model.apply_status(first, 1, wire.clone()).unwrap();
    let remount = model.select(&conversation, &run);
    wire.capabilities.stop = false;
    model.apply_status(remount, 60001, wire.clone()).unwrap();
    assert!(!model.fresh(60001));
    assert!(!model.can_stop(60001));
    let again = model.select(&conversation, &run);
    wire.capabilities.stop = true;
    model.apply_status(again, 60002, wire).unwrap();
    assert!(!model.fresh(60002));
    assert!(model.can_stop(60002));
}
