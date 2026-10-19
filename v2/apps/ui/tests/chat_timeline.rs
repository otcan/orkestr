use orkestr_v2_contracts::AcceptedResult;
use orkestr_v2_ui::chat_timeline::{merge_replies, ordered, Input, Row};
use serde_json::json;
use std::collections::BTreeMap;

fn reply(sequence: i64) -> AcceptedResult {
    serde_json::from_value(json!({"run_id":"00000000-0000-4000-8000-000000000001", "completion_event_id":"00000000-0000-4000-8000-000000000002", "acceptance_event_id":"00000000-0000-4000-8000-000000000003", "acceptance_sequence":sequence,"payload_id":"00000000-0000-4000-8000-000000000004","payload_removed":false})).unwrap()
}
fn input(sequence: i64) -> Input {
    Input {
        id: "synthetic-message".into(),
        sequence,
        actor: "owner".into(),
        text: "Question".into(),
    }
}
#[test]
fn transcript_interleaves_input_and_accepted_reply_by_canonical_event_order() {
    let rows = ordered(&[input(9), input(1)], &[reply(5)]).unwrap();
    assert_eq!(
        rows.iter().map(Row::sequence).collect::<Vec<_>>(),
        [1, 5, 9]
    );
    assert!(matches!(rows[1], Row::Reply(_)));
    assert_ne!(rows[0].key(), rows[1].key());
}
#[test]
fn conflicting_and_noncanonical_order_is_not_presented_as_chat() {
    assert!(ordered(&[input(5)], &[reply(5)]).is_err());
    assert!(ordered(&[input(0)], &[]).is_err());
}
#[test]
fn accepted_identity_cannot_be_replaced_and_removal_is_sticky() {
    let original = reply(5);
    let mut rows = BTreeMap::new();
    merge_replies(&mut rows, std::slice::from_ref(&original)).unwrap();
    let mut removed = original.clone();
    removed.payload_removed = true;
    merge_replies(&mut rows, &[removed]).unwrap();
    merge_replies(&mut rows, std::slice::from_ref(&original)).unwrap();
    assert!(rows[&5].payload_removed);
    let mut changed = original;
    changed.payload_id = None;
    assert!(merge_replies(&mut rows, &[changed]).is_err());
    assert!(rows[&5].payload_id.is_some());
}
