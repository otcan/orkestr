use orkestr_v2_contracts::{ExecutionWindowAdmission, ExecutionWindowState, ExecutionWindowStatus};
use orkestr_v2_ui::{
    beta_inputs::{SavedInput, SavedInputs},
    beta_window::WindowIntents,
    send_intent::{prepare, same_input},
    Draft,
};
use serde_json::json;
const ID: &str = "00000000-0000-4000-8000-000000000001";
fn input(n: u32) -> SavedInput {
    SavedInput {conversation:serde_json::from_value(json!(ID)).unwrap(),input_request_key:format!("input-{n}"),receipt:serde_json::from_value(json!({"message_id":format!("00000000-0000-4000-8000-{n:012}"),"event_id":format!("00000000-0000-4000-8000-{:012}",n+100),"sequence":n,"status":"accepted"})).unwrap()}
}
fn window() -> ExecutionWindowStatus {
    serde_json::from_value(json!({"conversation_id":ID,"window_id":"00000000-0000-4000-8000-000000000999","generation":7,"state":"active","input_message_id":input(2).receipt.message_id,"input_event_id":input(2).receipt.event_id,"predecessor_window_id":null,"opened_at_ms":1000,"work_deadline_ms":871000,"expires_at_ms":901000,"limits":{"duration_ms":900000,"attempts":32,"bytes":67108864,"cleanup_ms":30000,"cleanup_attempts":4,"cleanup_bytes":1048576}})).unwrap()
}
#[test]
fn send_admits_its_exact_saved_input_not_the_oldest_held_row() {
    let mut saved = SavedInputs::default();
    let old = input(2);
    let sent = input(3);
    saved.retain_receipt(old.clone());
    saved.retain_receipt(sent.clone());
    let exact = saved.request(ID, "input-3").unwrap();
    let request = prepare(&exact, None, "send".into()).unwrap();
    assert!(same_input(&request, &sent));
    assert!(!same_input(&request, &old));
    assert_eq!(request.expected_generation, 0);
    assert!(request.window_id.is_none());
    assert!(request.predecessor_window_id.is_none());
    assert!(saved.request(ID, "unknown").is_none());
    assert!(saved.request("foreign", "input-3").is_none());
}
#[test]
fn active_join_and_closed_successor_keep_the_observed_generation_and_identity() {
    let mut status = window();
    let sent = input(3);
    let join = prepare(&sent, Some(&status), "join".into()).unwrap();
    assert_eq!(join.expected_generation, 7);
    assert_eq!(join.window_id, Some(status.window_id));
    assert!(join.predecessor_window_id.is_none());
    status.state = ExecutionWindowState::Closed;
    let successor = prepare(&sent, Some(&status), "next".into()).unwrap();
    assert_eq!(successor.expected_generation, 7);
    assert_eq!(successor.predecessor_window_id, Some(status.window_id));
    assert!(successor.window_id.is_none());
}
#[test]
fn foreign_uncertain_or_changed_budget_status_cannot_authorize_send() {
    let original = window();
    for state in [
        ExecutionWindowState::Opening,
        ExecutionWindowState::Retiring,
        ExecutionWindowState::ReconciliationRequired,
    ] {
        let mut s = original.clone();
        s.state = state;
        assert!(prepare(&input(3), Some(&s), "send".into()).is_err());
    }
    let mut altered = Vec::new();
    let mut s = original.clone();
    s.conversation_id =
        serde_json::from_value(json!("00000000-0000-4000-8000-000000000002")).unwrap();
    altered.push(s);
    let mut s = original.clone();
    s.generation = 9_007_199_254_740_992;
    altered.push(s);
    let mut s = original.clone();
    s.limits.attempts += 1;
    altered.push(s);
    let mut s = original.clone();
    s.expires_at_ms += 1;
    altered.push(s);
    let mut s = original;
    s.work_deadline_ms -= 1;
    altered.push(s);
    for s in altered {
        assert!(prepare(&input(3), Some(&s), "send".into()).is_err());
    }
}
#[test]
fn unknown_response_keeps_both_keys_and_success_preserves_newer_composer_edits() {
    let mut draft = Draft::default();
    draft.edit("Original message".into());
    let sent = draft.prepare("input-3".into()).unwrap();
    let saved_input = input(3);
    let mut saved = SavedInputs::default();
    saved.retain_receipt(saved_input.clone());
    let mut intents = WindowIntents::default();
    let original = prepare(&saved_input, None, "original-admission".into()).unwrap();
    intents.prepare(ID, original.clone());
    let ticket = intents.ticket(ID).unwrap();
    draft.edit("Next message".into());
    let retried = draft.prepare("different".into()).unwrap();
    assert_eq!(retried.client_message_id, sent.client_message_id);
    assert_eq!(retried.text, sent.text);
    assert_eq!(
        intents.prepare(
            ID,
            prepare(&saved_input, Some(&window()), "different".into()).unwrap()
        ),
        Some(original.clone())
    );
    let mut status = window();
    status.generation = 1;
    status.state = ExecutionWindowState::Opening;
    let receipt = ExecutionWindowAdmission {
        status,
        input_message_id: original.input_message_id,
        input_event_id: original.input_event_id,
        input_request_key: original.input_request_key,
        request_key: original.request_key,
        duplicate: true,
    };
    assert!(intents.complete(ID, &ticket, &receipt, &mut saved));
    draft.accepted();
    assert_eq!(draft.text, "Next message");
    assert!(draft.pending.is_none());
    assert!(saved.request(ID, "input-3").is_none());
}
#[test]
fn refusal_review_is_route_and_ticket_scoped_and_late_responses_stay_fenced() {
    let mut intents = WindowIntents::default();
    let sent = input(3);
    let original = prepare(&sent, None, "first".into()).unwrap();
    intents.prepare(ID, original);
    let ticket = intents.ticket(ID).unwrap();
    intents.mark_refused("foreign", &ticket);
    assert!(!intents.refused(ID));
    intents.mark_refused(ID, &ticket);
    assert!(intents.refused(ID));
    assert!(intents.review_refusal(ID, &ticket));
    assert!(!intents.refused(ID));
    intents.prepare(
        ID,
        prepare(&sent, Some(&window()), "reviewed".into()).unwrap(),
    );
    intents.mark_refused(ID, &ticket);
    assert!(!intents.refused(ID));
    assert!(!intents.current(ID, &ticket));
    assert_eq!(intents.pending(ID).unwrap().request_key, "reviewed");
    intents.clear_scope();
    assert!(intents.pending(ID).is_none());
    assert!(WindowIntents::default().pending(ID).is_none());
}
