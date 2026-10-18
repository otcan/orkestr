use orkestr_v2_contracts::*;
use orkestr_v2_ui::{acceptance::Acceptances, decode_stream, execution::Execution, is_replay_item};
fn proposal() -> ConversationEvent {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/provider-observed-progress.json"
    ))
    .unwrap();
    value["schema_version"] = 5.into();
    value["sequence"] = 7.into();
    value["aggregate_version"] = 7.into();
    value["payload_ref_or_safe_payload"]["observation"] =
        serde_json::json!({"kind":"completed_proposal"});
    serde_json::from_value(value).unwrap()
}
fn status() -> ExecutionStatus {
    let event = proposal();
    let ConversationEvent::ProviderObserved(e) = event else {
        unreachable!()
    };
    serde_json::from_value(serde_json::json!({"schema_version":1,"conversation_id":e.aggregate_id,"run_id":e.payload_ref_or_safe_payload.run_id,"revision":9,"observed_at_ms":9000000,"phase":"awaiting_acceptance","queue_age_ms":null,"progress":null,"resources":null,"capabilities":{"stop":false,"steer":false}})).unwrap()
}
fn receipt(p: &orkestr_v2_ui::acceptance::PendingAcceptance) -> ExecutionAcceptanceReceipt {
    serde_json::from_value(serde_json::json!({"schema_version":1,"conversation_id":p.conversation,"run_id":p.request.run_id,"completion_event_id":p.request.completion_event_id,"acceptance_event_id":"00000000-0000-4000-8000-000000000099","request_key":p.request.request_key,"requested_revision":p.request.expected_revision,"revision":p.request.expected_revision+1,"outcome":"succeeded"})).unwrap()
}
#[test]
fn only_validated_matching_proposal_and_awaiting_status_allow_explicit_decision() {
    let mut a = Acceptances::default();
    let mut status = status();
    assert!(!a.available(&status));
    a.observe(&proposal());
    assert!(a.available(&status));
    status.phase = ExecutionPhase::Running;
    assert!(!a.available(&status));
    status.phase = ExecutionPhase::AwaitingAcceptance;
    status.revision = 6;
    assert!(!a.available(&status));
    status.revision = 9;
    status.run_id = Some(
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000098")).unwrap(),
    );
    assert!(!a.available(&status));
}
#[test]
fn uncertain_retry_keeps_exact_completion_run_revision_key_and_does_not_accept_automatically() {
    let mut a = Acceptances::default();
    let mut status = status();
    a.observe(&proposal());
    let p = a.prepare(&status, "accept:original".into()).unwrap();
    for code in [0, 400, 404, 409, 503] {
        a.failed(&p, code);
        assert!(!a
            .notice(&status)
            .unwrap()
            .starts_with("Completion accepted"));
    }
    status.revision = 12;
    status.phase = ExecutionPhase::Completed;
    assert!(a.available(&status));
    let retry = a.prepare(&status, "replacement".into()).unwrap();
    assert_eq!(p.request, retry.request);
    a.receipt(&retry, receipt(&p)).unwrap();
    assert_eq!(a.notice(&status), Some("Completion accepted."));
    assert!(!a.available(&status));
    assert_eq!(status.phase, ExecutionPhase::Completed);
}
#[test]
fn mismatched_receipt_and_late_owner_callbacks_cannot_confirm_acceptance() {
    let mut a = Acceptances::default();
    let status = status();
    a.observe(&proposal());
    let p = a.prepare(&status, "accept:original".into()).unwrap();
    for index in 0..5 {
        let mut r = receipt(&p);
        match index {
            0 => r.request_key = "other".into(),
            1 => r.requested_revision -= 1,
            2 => r.completion_event_id = r.acceptance_event_id.clone(),
            3 => {
                r.run_id = serde_json::from_value(serde_json::json!(
                    "00000000-0000-4000-8000-000000000098"
                ))
                .unwrap()
            }
            _ => {
                r.conversation_id = serde_json::from_value(serde_json::json!(
                    "00000000-0000-4000-8000-000000000098"
                ))
                .unwrap()
            }
        };
        assert!(a.receipt(&p, r).is_err());
    }
    a.clear_owner();
    assert!(a.receipt(&p, receipt(&p)).is_err());
    assert!(!a.available(&status));
}
#[test]
fn navigation_preserves_owner_decision_but_logout_clears_it_without_touching_draft() {
    let mut model = Execution::default();
    let status = status();
    let generation = model.select(&status.conversation_id.to_string(), "");
    model.apply_status(generation, 1, status.clone()).unwrap();
    model.acceptances.observe(&proposal());
    let p = model
        .acceptances
        .prepare(&status, "accept:original".into())
        .unwrap();
    model.select("other", "");
    assert!(model.control_status().is_none());
    let generation = model.select(&status.conversation_id.to_string(), "");
    model
        .apply_status(generation, 60000, status.clone())
        .unwrap();
    assert!(!model.fresh(60000));
    assert_eq!(
        model
            .acceptances
            .prepare(&status, "replacement".into())
            .unwrap()
            .request,
        p.request
    );
    model.authorization_lost();
    assert!(!model.acceptances.available(&status));
}
#[test]
fn production_variants_reach_conversation_reconciliation_not_fixture_only_filter() {
    for (name, body) in [
        (
            "provider_observed",
            serde_json::to_value(proposal()).unwrap(),
        ),
        (
            "execution_accepted",
            serde_json::from_str(include_str!("../../../fixtures/execution-accepted.json"))
                .unwrap(),
        ),
    ] {
        let item =
            decode_stream(serde_json::json!({"status":200,"event":name,"id":"7","body":body}));
        assert!(is_replay_item(&item));
        let wrong = decode_stream(
            serde_json::json!({"status":200,"event":"message_accepted","id":"7","body":item.body}),
        );
        assert!(!is_replay_item(&wrong));
    }
}
#[test]
fn conflict_requires_explicit_review_before_new_revision_or_key() {
    let mut a = Acceptances::default();
    let mut status = status();
    a.observe(&proposal());
    let original = a.prepare(&status, "original".into()).unwrap();
    a.failed(&original, 409);
    assert!(!a.can_review_updated(&status));
    status.revision += 1;
    assert!(a.can_review_updated(&status));
    assert_eq!(
        a.prepare(&status, "silent-rekey".into()).unwrap().request,
        original.request
    );
    a.review_updated(&status).unwrap();
    let replacement = a.prepare(&status, "explicit-new-decision".into()).unwrap();
    assert_eq!(replacement.request.expected_revision, status.revision);
    assert_ne!(
        replacement.request.request_key,
        original.request.request_key
    );
    assert_eq!(
        replacement.request.completion_event_id,
        original.request.completion_event_id
    );
    assert!(a.receipt(&original, receipt(&original)).is_err());
}
#[test]
fn reload_discovers_exact_candidate_and_equal_revision_identity_changes_fail_closed() {
    let mut wire = status();
    let ConversationEvent::ProviderObserved(proposal) = proposal() else {
        unreachable!()
    };
    wire.acceptance_candidate = Some(ExecutionAcceptanceCandidate {
        run_id: proposal.payload_ref_or_safe_payload.run_id,
        completion_event_id: proposal.event_id,
    });
    let mut model = Execution::default();
    let g = model.select(&wire.conversation_id.to_string(), "");
    model.apply_status(g, 100, wire.clone()).unwrap();
    assert!(model.acceptances.available(&wire));
    let pending = model
        .acceptances
        .prepare(&wire, "explicit-reload".into())
        .unwrap();
    assert_eq!(
        pending.request.completion_event_id,
        wire.acceptance_candidate
            .as_ref()
            .unwrap()
            .completion_event_id
    );
    let mut changed = wire.clone();
    changed
        .acceptance_candidate
        .as_mut()
        .unwrap()
        .completion_event_id =
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000098")).unwrap();
    assert!(model.apply_status(g, 101, changed).is_err());
    changed = wire.clone();
    changed.phase = ExecutionPhase::Running;
    assert!(model.apply_status(g, 102, changed).is_err());
    model.authorization_lost();
    assert!(!model.acceptances.available(&wire));
}
