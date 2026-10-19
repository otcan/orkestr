use orkestr_v2_contracts::{ExecutionWindowAdmission, ExecutionWindowRequest};
use orkestr_v2_ui::{
    beta_inputs::{SavedInput, SavedInputs},
    beta_window::WindowIntents,
};
const A: &str = "00000000-0000-4000-8000-000000000001";
const B: &str = "00000000-0000-4000-8000-000000000002";
fn request(key: &str, n: u32) -> ExecutionWindowRequest {
    serde_json::from_value(serde_json::json!({"request_key":key,"input_request_key":format!("input-{n}"),"input_message_id":format!("00000000-0000-4000-8000-{n:012}"),"input_event_id":format!("00000000-0000-4000-8000-{n:012}"),"expected_generation":0,"window_id":null,"predecessor_window_id":null})).unwrap()
}
fn receipt(route: &str, r: &ExecutionWindowRequest) -> ExecutionWindowAdmission {
    serde_json::from_value(serde_json::json!({"status":{"conversation_id":route,"window_id":"00000000-0000-4000-8000-000000000099","generation":1,"state":"opening","input_message_id":r.input_message_id,"input_event_id":r.input_event_id,"predecessor_window_id":null,"opened_at_ms":1,"work_deadline_ms":870001,"expires_at_ms":900001,"limits":{"duration_ms":900000,"attempts":32,"bytes":67108864,"cleanup_ms":30000,"cleanup_attempts":4,"cleanup_bytes":1048576}},"input_message_id":r.input_message_id,"input_event_id":r.input_event_id,"input_request_key":r.input_request_key,"request_key":r.request_key,"duplicate":true})).unwrap()
}
fn save(q: &mut SavedInputs, route: &str, r: &ExecutionWindowRequest, n: i64) {
    assert!(q.retain_receipt(SavedInput{conversation:serde_json::from_value(serde_json::json!(route)).unwrap(),input_request_key:r.input_request_key.clone(),receipt:serde_json::from_value(serde_json::json!({"message_id":r.input_message_id,"event_id":r.input_event_id,"sequence":n,"status":"accepted"})).unwrap()}));
}
#[test]
fn navigation_retry_refusal_and_success_cannot_cross_routes() {
    let mut intents = WindowIntents::default();
    let mut saved = SavedInputs::default();
    let a = request("uncertain-a", 10);
    let b = request("new-b", 20);
    save(&mut saved, A, &a, 1);
    save(&mut saved, B, &b, 2);
    assert_eq!(intents.prepare(A, a.clone()), Some(a.clone()));
    let ta = intents.ticket(A).unwrap();
    assert_eq!(intents.prepare(B, b.clone()), Some(b.clone()));
    let tb = intents.ticket(B).unwrap();
    assert_eq!(
        intents.prepare(A, request("changed-a", 30)),
        Some(a.clone())
    );
    assert!(!intents.review_refusal(B, &ta));
    assert!(!intents.complete(B, &ta, &receipt(A, &a), &mut saved));
    assert!(intents.review_refusal(B, &tb));
    assert_eq!(intents.pending(A), Some(&a));
    assert!(!intents.complete(B, &tb, &receipt(B, &b), &mut saved)); // old callback after review
    assert!(intents.complete(A, &ta, &receipt(A, &a), &mut saved));
    assert!(saved.first(A).is_none());
    assert!(saved.first(B).is_some());
    assert!(!intents.complete(A, &ta, &receipt(A, &a), &mut saved));
}
#[test]
fn success_removes_pending_tuple_not_current_first_row_and_owner_reset_fences_tickets() {
    let mut intents = WindowIntents::default();
    let mut saved = SavedInputs::default();
    let first = request("older", 10);
    let pending = request("chosen", 11);
    save(&mut saved, A, &first, 1);
    save(&mut saved, A, &pending, 2);
    intents.prepare(A, pending.clone());
    let ticket = intents.ticket(A).unwrap();
    assert!(intents.complete(A, &ticket, &receipt(A, &pending), &mut saved));
    assert_eq!(
        saved.first(A).unwrap().input_request_key,
        first.input_request_key
    );
    intents.prepare(A, pending.clone());
    let old = intents.ticket(A).unwrap();
    intents.clear_scope();
    intents.prepare(A, pending.clone());
    assert!(!intents.review_refusal(A, &old));
    assert!(!intents.complete(A, &old, &receipt(A, &pending), &mut saved));
}
