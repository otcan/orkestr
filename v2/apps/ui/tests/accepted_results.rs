use orkestr_v2_contracts::{AcceptedResults, ProviderPayload};
use orkestr_v2_ui::{
    accepted_results::{bound_payload, valid_page},
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
