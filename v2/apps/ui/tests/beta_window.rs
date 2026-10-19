use orkestr_v2_contracts::ExecutionWindowRequest;
use orkestr_v2_ui::beta_window::WindowIntent;
fn request(key: &str) -> ExecutionWindowRequest {
    serde_json::from_value(serde_json::json!({
        "request_key":key,
        "input_request_key":"durable-input-1",
        "input_message_id":"00000000-0000-4000-8000-000000000001",
        "input_event_id":"00000000-0000-4000-8000-000000000002",
        "expected_generation":9223372036854775807_u64,
        "window_id":null,"predecessor_window_id":null
    }))
    .unwrap()
}
#[test]
fn uncertain_retry_preserves_entire_tuple_and_exact_generation() {
    let mut intent = WindowIntent::default();
    let original = request("first");
    assert_eq!(intent.prepare(original.clone()), Some(original.clone()));
    let mut changed = request("second");
    changed.expected_generation = 0;
    assert_eq!(intent.prepare(changed), Some(original));
}
#[test]
fn owner_change_invalidates_old_callbacks_and_pending_intent() {
    let mut intent = WindowIntent::default();
    let old = intent.generation();
    intent.prepare(request("first"));
    intent.clear_scope();
    intent.prepare(request("new-owner"));
    assert!(!intent.review_refusal(old));
    assert_eq!(intent.pending().unwrap().request_key, "new-owner");
}
#[test]
fn explicit_review_required_and_invalid_requests_do_not_become_pending() {
    let mut intent = WindowIntent::default();
    let mut invalid = request("bad");
    invalid.expected_generation = u64::MAX;
    assert!(intent.prepare(invalid).is_none());
    intent.prepare(request("first"));
    assert!(intent.review_refusal(intent.generation()));
    assert_eq!(
        intent.prepare(request("reviewed")).unwrap().request_key,
        "reviewed"
    );
}
