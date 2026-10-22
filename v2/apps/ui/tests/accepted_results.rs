use orkestr_v2_contracts::{AcceptedResults, ProviderPayload};
use orkestr_v2_ui::{
    accepted_results::{bound_payload, next_chat_page, refresh_cursor, valid_page},
    payload::Output,
};
use serde_json::json;
const C: &str = "00000000-0000-4000-8000-000000000001";
fn page() -> AcceptedResults {
    serde_json::from_value(json!({"conversation_id":C,"results":[{"run_id":C,"completion_event_id":"00000000-0000-4000-8000-000000000002","acceptance_event_id":"00000000-0000-4000-8000-000000000003","acceptance_sequence":7,"payload_id":C,"payload_removed":false}],"next_after_sequence":7})).unwrap()
}
#[test]
fn bounded_scope_and_cursor() {
    let mut p = page();
    assert!(valid_page(&p, C, 0));
    assert!(!valid_page(&p, C, 7));
    assert!(!valid_page(&p, "00000000-0000-4000-8000-000000000009", 0));
    p.next_after_sequence = Some(8);
    assert!(!valid_page(&p, C, 0));
    p = page();
    p.results = vec![p.results[0].clone(); 21];
    assert!(!valid_page(&p, C, 0));
}
#[test]
fn payload_requires_exact_run_scope_and_reference() {
    let mut p = page();
    let mut bytes: ProviderPayload = serde_json::from_value(
        json!({"conversation_id":C,"run_id":C,"payload_id":C,"text":"accepted synthetic reply"}),
    )
    .unwrap();
    assert!(bound_payload(&p.results[0], C, &bytes));
    bytes.run_id = serde_json::from_value(json!("00000000-0000-0000-0000-000000000000")).unwrap();
    assert!(!bound_payload(&p.results[0], C, &bytes));
    bytes.run_id = p.results[0].run_id.clone();
    p.results[0].payload_removed = true;
    assert!(!bound_payload(&p.results[0], C, &bytes));
    p.results[0].payload_removed = false;
    p.results[0].payload_id = None;
    assert!(!bound_payload(&p.results[0], C, &bytes));
}
#[test]
fn tombstone_never_rejuvenates_delayed_text() {
    let mut output = Output::default();
    output.observed(Some("old".into()));
    output.observed(None);
    output.observed(Some("late".into()));
    assert!(output.removed());
    assert!(output.text.is_none());
}

#[test]
fn chat_follows_pages_to_the_newest_reply() {
    let mut p = page();
    // The chat keeps reading forward; the history view reads one page.
    assert_eq!(next_chat_page(&p, true, 0), Some(7));
    assert_eq!(next_chat_page(&p, false, 0), None);
    // A cursor that does not advance never loops.
    assert_eq!(next_chat_page(&p, true, 7), None);
    p.next_after_sequence = None;
    assert_eq!(next_chat_page(&p, true, 0), None);
}

#[test]
fn live_refresh_reads_after_the_newest_reply_shown() {
    // The stream may jump past an accepted reply (sequence 384) straight to
    // the journal watermark (403); reading after the newest shown reply (372)
    // still returns it, unlike reading only the event that arrived.
    assert_eq!(refresh_cursor(Some(372), true, 0), 372);
    assert_eq!(refresh_cursor(None, true, 0), 0);
    assert_eq!(refresh_cursor(Some(372), false, 20), 20);
}
