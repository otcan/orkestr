use orkestr_v2_contracts::{ExecutionStatus, ExecutionStopReceipt};
use orkestr_v2_ui::{execution::Execution, stop::Stops};
fn status() -> ExecutionStatus {
    serde_json::from_value(serde_json::json!({"schema_version":1,"conversation_id":"00000000-0000-4000-8000-000000000003","run_id":"00000000-0000-4000-8000-000000000005","revision":10,"observed_at_ms":9000000,"phase":"running","queue_age_ms":null,"progress":null,"resources":null,"capabilities":{"stop":true,"steer":false}})).unwrap()
}
fn receipt(outcome: &str) -> ExecutionStopReceipt {
    serde_json::from_value(serde_json::json!({"schema_version":1,"conversation_id":"00000000-0000-4000-8000-000000000003","run_id":"00000000-0000-4000-8000-000000000005","request_key":"stop:original","requested_revision":10,"revision":11,"outcome":outcome})).unwrap()
}
#[test]
fn hung_provider_stop_uses_canonical_identity_despite_stale_telemetry() {
    let mut model = Execution::default();
    let wire = status();
    let g = model.select(&wire.conversation_id.to_string(), "");
    model.apply_status(g, 1, wire.clone()).unwrap();
    model.disconnected();
    assert!(!model.fresh(60000));
    assert!(model.can_stop(60000));
    let pending = model
        .stops
        .prepare(&model.control_status().unwrap(), "stop:original".into())
        .unwrap();
    assert_eq!(pending.request.expected_revision, 10);
    model.authorization_lost();
    assert!(model.control_status().is_none());
    assert!(model
        .stops
        .receipt(&pending, receipt("requested_unknown"))
        .is_err());
}
#[test]
fn uncertain_retry_retains_exact_request_after_status_revision_advances() {
    let mut stops = Stops::default();
    let mut wire = status();
    let original = stops.prepare(&wire, "stop:original".into()).unwrap();
    for code in [0, 400, 404, 503] {
        stops.failed(&original, code);
        assert!(!stops.notice(&wire).unwrap().starts_with("Cancelled"));
    }
    wire.revision = 20;
    wire.capabilities.stop = false;
    wire.phase = orkestr_v2_contracts::ExecutionPhase::CancelRequested;
    let retry = stops
        .prepare(&wire, "replacement-must-not-be-used".into())
        .unwrap();
    assert_eq!(
        serde_json::to_value(&original.request).unwrap(),
        serde_json::to_value(&retry.request).unwrap()
    );
    stops.receipt(&retry, receipt("requested_unknown")).unwrap();
    assert_eq!(
        stops.notice(&wire),
        Some("Stop requested; provider interruption is unconfirmed.")
    );
}
#[test]
fn receipt_identity_revision_and_owner_must_match_without_changing_execution_phase() {
    let mut stops = Stops::default();
    let wire = status();
    let pending = stops.prepare(&wire, "stop:original".into()).unwrap();
    for i in 0..5 {
        let mut bad = receipt("requested_unknown");
        match i {
            0 => bad.request_key = "other".into(),
            1 => bad.requested_revision = 9,
            2 => bad.revision = 10,
            3 => {
                bad.run_id = serde_json::from_value(serde_json::json!(
                    "00000000-0000-4000-8000-000000000099"
                ))
                .unwrap()
            }
            _ => {
                bad.conversation_id = serde_json::from_value(serde_json::json!(
                    "00000000-0000-4000-8000-000000000099"
                ))
                .unwrap()
            }
        };
        assert!(stops.receipt(&pending, bad).is_err());
    }
    stops.clear_owner();
    assert!(stops.notice(&wire).is_none());
    assert!(stops.receipt(&pending, receipt("not_dispatched")).is_err());
    let pending = stops.prepare(&wire, "stop:original".into()).unwrap();
    stops.receipt(&pending, receipt("not_dispatched")).unwrap();
    assert_eq!(
        stops.notice(&wire),
        Some("Cancelled before provider delivery.")
    );
    assert_eq!(wire.phase, orkestr_v2_contracts::ExecutionPhase::Running);
}
#[test]
fn navigation_new_run_and_missing_identity_cannot_retarget_pending_stop() {
    let mut stops = Stops::default();
    let mut wire = status();
    stops.prepare(&wire, "stop:original".into()).unwrap();
    wire.run_id = Some(
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000099")).unwrap(),
    );
    let new = stops.prepare(&wire, "new".into()).unwrap();
    assert_ne!(new.request.run_id, status().run_id.unwrap());
    assert!(stops.retryable(&status()));
    wire.run_id = None;
    wire.capabilities.stop = false;
    wire.phase = orkestr_v2_contracts::ExecutionPhase::Queued;
    assert!(stops.prepare(&wire, "new".into()).is_err());
    let mut model = Execution::default();
    let old = status();
    let g = model.select(&old.conversation_id.to_string(), "");
    model.apply_status(g, 1, old).unwrap();
    model.select("other", "");
    assert!(model.control_status().is_none());
}

#[test]
fn stale_refusal_requires_explicit_review_same_run_and_new_revision() {
    let mut stops = Stops::default();
    let mut wire = status();
    let old = stops.prepare(&wire, "stop:original".into()).unwrap();
    stops.failed(&old, 409);
    assert!(stops.needs_review(&wire));
    assert!(!stops.retryable(&wire));
    assert!(!stops.can_review(&wire));
    assert!(stops.review(&wire).is_err());
    wire.revision += 1;
    let mut wrong = wire.clone();
    wrong.run_id = None;
    wrong.capabilities.stop = false;
    assert!(stops.review(&wrong).is_err());
    assert!(stops.prepare(&wire, "must-not-send".into()).is_err());
    stops.review(&wire).unwrap();
    let next = stops.prepare(&wire, "stop:reviewed".into()).unwrap();
    assert_eq!(next.request.expected_revision, 11);
    assert_ne!(next.request.request_key, old.request.request_key);
    assert!(stops.receipt(&old, receipt("requested_unknown")).is_err());
}
#[test]
fn public_stop_receipt_never_sets_terminal_execution_state() {
    let mut model = Execution::default();
    let mut wire = status();
    let g = model.select(&wire.conversation_id.to_string(), "");
    model.apply_status(g, 1, wire.clone()).unwrap();
    let pending = model.stops.prepare(&wire, "stop:original".into()).unwrap();
    model
        .stops
        .receipt(&pending, receipt("requested_unknown"))
        .unwrap();
    assert_eq!(
        model.control_status().unwrap().phase,
        orkestr_v2_contracts::ExecutionPhase::Running
    );
    wire.revision = 11;
    wire.phase = orkestr_v2_contracts::ExecutionPhase::CancelRequested;
    wire.capabilities.stop = false;
    model.apply_status(g, 2, wire.clone()).unwrap();
    assert!(!model.summary(2).contains("Cancelled"));
    wire.revision = 12;
    wire.phase = orkestr_v2_contracts::ExecutionPhase::Cancelled;
    model.apply_status(g, 3, wire).unwrap();
    assert!(model.summary(3).contains("Cancelled"));
}

#[test]
fn streaming_projection_does_not_replace_sampled_run_control_precondition() {
    let mut stops = Stops::default();
    let mut wire = status();
    wire.control_revision = Some(3);
    let original = stops.prepare(&wire, "stop:original".into()).unwrap();
    assert_eq!(original.request.expected_control_revision, Some(3));
    // Progress and sibling activity may advance the full projection independently.
    wire.revision += 65;
    stops.failed(&original, 0);
    let retry = stops.prepare(&wire, "unused".into()).unwrap();
    assert_eq!(
        serde_json::to_value(&original.request).unwrap(),
        serde_json::to_value(&retry.request).unwrap()
    );
    // Even a definitive refusal cannot turn progress into automatic control review.
    stops.failed(&original, 409);
    assert!(!stops.can_review(&wire));
    wire.control_revision = Some(4);
    assert!(stops.can_review(&wire));
    stops.review(&wire).unwrap();
    let reviewed = stops.prepare(&wire, "stop:reviewed".into()).unwrap();
    assert_eq!(reviewed.request.expected_revision, 75);
    assert_eq!(reviewed.request.expected_control_revision, Some(4));
    let mut forged = reviewed.clone();
    forged.request.expected_control_revision = Some(3);
    stops.failed(&forged, 409);
    assert!(!stops.needs_review(&wire));
    assert!(stops
        .receipt(&original, receipt("requested_unknown"))
        .is_err());
}

#[test]
fn invalid_control_revision_is_refused_and_legacy_omits_new_field() {
    let mut stops = Stops::default();
    let mut wire = status();
    let legacy = stops.prepare(&wire, "legacy".into()).unwrap();
    assert!(serde_json::to_value(legacy.request)
        .unwrap()
        .get("expected_control_revision")
        .is_none());
    for revision in [0, -1] {
        wire.control_revision = Some(revision);
        assert!(stops.prepare(&wire, "invalid".into()).is_err());
    }
}
