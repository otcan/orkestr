use orkestr_v2_contracts::ExecutionWindowRequest;
use orkestr_v2_ui::beta_window::WindowIntent;
fn request(key: &str) -> ExecutionWindowRequest {
    serde_json::from_value(serde_json::json!({
        "request_key":key,
        "input_request_key":"durable-input-1",
        "input_message_id":"00000000-0000-4000-8000-000000000001",
        "input_event_id":"00000000-0000-4000-8000-000000000002",
        "expected_generation":9007199254740991_u64,
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

#[test]
fn immutable_receipt_binds_input_key_ids_and_exact_window_generation() {
    use orkestr_v2_contracts::ExecutionWindowAdmission;
    let mut intent = WindowIntent::default();
    let mut input = request("admit");
    input.expected_generation = 0;
    intent.prepare(input.clone());
    let mut receipt:ExecutionWindowAdmission=serde_json::from_value(serde_json::json!({
        "status":{"window_id":"00000000-0000-4000-8000-000000000003","conversation_id":"00000000-0000-4000-8000-000000000004","generation":1,"state":"opening","input_message_id":input.input_message_id,"input_event_id":input.input_event_id,"predecessor_window_id":null,"opened_at_ms":1000,"work_deadline_ms":871000,"expires_at_ms":901000,"limits":{"duration_ms":900000,"attempts":32,"bytes":67108864,"cleanup_ms":30000,"cleanup_attempts":4,"cleanup_bytes":1048576}},
        "input_message_id":input.input_message_id,"input_event_id":input.input_event_id,"input_request_key":input.input_request_key,"request_key":input.request_key,"duplicate":true
    })).unwrap();
    assert!(intent.receipt_matches(intent.generation(), &receipt));
    receipt.status.generation = 2;
    assert!(!intent.receipt_matches(intent.generation(), &receipt));
    receipt.status.generation = 1;
    receipt.input_request_key = "foreign".into();
    assert!(!intent.receipt_matches(intent.generation(), &receipt));
    intent.clear_scope();
    assert!(!intent.receipt_matches(0, &receipt));
}

#[test]
fn queue_receipt_completes_only_its_exact_pending_send() {
    use orkestr_v2_contracts::{ConversationId, ExecutionWindowQueued, QueuedWindowState, Receipt};
    use orkestr_v2_ui::beta_inputs::{SavedInput, SavedInputs};
    use orkestr_v2_ui::beta_window::{queued_notice, WindowIntents};
    let route = "00000000-0000-4000-8000-000000000004";
    let mut input = request("queued-send");
    input.expected_generation = 0;
    let conversation: ConversationId = serde_json::from_value(serde_json::json!(route)).unwrap();
    let mut saved = SavedInputs::default();
    let receipt: Receipt = serde_json::from_value(serde_json::json!({
        "message_id":input.input_message_id,"event_id":input.input_event_id,"sequence":1,"status":"accepted"
    }))
    .unwrap();
    let kept = SavedInput {
        conversation: conversation.clone(),
        input_request_key: input.input_request_key.clone(),
        receipt,
    };
    assert!(saved.retain_receipt(kept));
    let mut intents = WindowIntents::default();
    intents.prepare(route, input.clone()).unwrap();
    let ticket = intents.ticket(route).unwrap();
    let mut queued = ExecutionWindowQueued {
        conversation_id: conversation,
        request_key: "another-send".into(),
        input_message_id: input.input_message_id.clone(),
        input_event_id: input.input_event_id.clone(),
        input_request_key: input.input_request_key.clone(),
        state: QueuedWindowState::Queued,
        position: Some(3),
        queued_at_ms: 1,
        window_id: None,
        withdrawal: None,
    };
    assert!(!intents.queued(route, &ticket, &queued, &mut saved));
    assert!(saved.first(route).is_some());
    queued.request_key = input.request_key.clone();
    assert!(queued_notice(&queued).contains("position 3"));
    assert!(intents.queued(route, &ticket, &queued, &mut saved));
    assert!(saved.first(route).is_none());
    assert!(intents.pending(route).is_none());
}
