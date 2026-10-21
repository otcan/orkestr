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
        reply_to: None,
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

#[test]
fn a_quoted_reply_shows_as_a_bubble_without_the_duplicate_relay_line() {
    use orkestr_v2_contracts::{Message, ReplyTo};
    let quote = ReplyTo {
        message_id: Some("true_chat_ABC".into()),
        author: Some("orkestr".into()),
        sent_at: None,
        text: "Should I look into it?".into(),
        is_own_reply: true,
        unavailable: false,
    };
    let message = Message {
        message_id: serde_json::from_value(json!("00000000-0000-4000-8000-000000000002")).unwrap(),
        sequence: 1,
        actor_kind: "owner".into(),
        text: "[WhatsApp: Group]\n\n[Replying to Orkestr message from 21:50: \"Should I look…\"]\n\nno need".into(),
        reply_to: Some(quote.clone()),
    };
    let input = Input::from(&message);
    assert_eq!(input.text, "[WhatsApp: Group]\n\nno need");
    assert_eq!(input.reply_to, Some(quote));
    assert_eq!(
        orkestr_v2_ui::chat_timeline::quote_label(input.reply_to.as_ref().unwrap()),
        "Replying to Orkestr"
    );
    let plain = Message {
        reply_to: None,
        ..message
    };
    assert!(
        Input::from(&plain).text.contains("[Replying to"),
        "no quote means the text is shown unchanged"
    );
    let gone = ReplyTo {
        unavailable: true,
        text: String::new(),
        message_id: None,
        is_own_reply: false,
        ..input.reply_to.unwrap()
    };
    assert_eq!(
        orkestr_v2_ui::chat_timeline::quote_label(&gone),
        "Replying to an unavailable message"
    );
}
