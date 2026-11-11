//! ORK-780: a re-admitted input shows as one message in the chat.
use orkestr_v2_contracts::ConversationSnapshot;
use orkestr_v2_ui::Projection;
use serde_json::{json, Value};

fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}
fn row(sequence: i64, text: &str, retry_of: Option<i64>) -> Value {
    let mut row = json!({"message_id": id(sequence as u32), "sequence": sequence, "actor_kind": "owner", "text": text});
    if let Some(earlier) = retry_of {
        row["retry_of"] = json!(id(earlier as u32));
    }
    row
}
fn page(rows: Vec<Value>, last: i64) -> ConversationSnapshot {
    serde_json::from_value(json!({"conversation_id": id(900), "scope": {"kind": "global"}, "messages": rows, "last_sequence": last, "next_cursor": null})).unwrap()
}
fn texts(view: &Projection) -> Vec<(i64, String)> {
    view.messages
        .values()
        .map(|message| (message.sequence, message.text.clone()))
        .collect()
}

#[test]
fn a_live_retry_replaces_the_attempt_already_shown() {
    let mut view = Projection::default();
    view.page(page(vec![row(1, "Synthetic request", None)], 1))
        .unwrap();
    assert_eq!(texts(&view), vec![(1, "Synthetic request".into())]);
    // The adapter retried the input: the catch-up page has only the new row.
    view.page(page(vec![row(2, "Synthetic request", Some(1))], 2))
        .unwrap();
    assert_eq!(texts(&view), vec![(2, "Synthetic request".into())]);
    // A second retry of the retry still leaves one message.
    view.page(page(vec![row(3, "Synthetic request", Some(2))], 3))
        .unwrap();
    assert_eq!(texts(&view), vec![(3, "Synthetic request".into())]);
}

#[test]
fn a_retry_in_the_same_page_as_its_attempt_still_shows_once() {
    let mut view = Projection::default();
    view.page(page(
        vec![
            row(1, "Synthetic request", None),
            row(2, "Synthetic other", None),
            row(3, "Synthetic request", Some(1)),
        ],
        3,
    ))
    .unwrap();
    assert_eq!(
        texts(&view),
        vec![
            (2, "Synthetic other".into()),
            (3, "Synthetic request".into())
        ]
    );
}

#[test]
fn identical_messages_sent_twice_both_stay() {
    let mut view = Projection::default();
    view.page(page(
        vec![
            row(1, "Synthetic twice", None),
            row(2, "Synthetic twice", None),
            // The second one was retried; the first is a separate message.
            row(3, "Synthetic twice", Some(2)),
        ],
        3,
    ))
    .unwrap();
    assert_eq!(
        texts(&view),
        vec![(1, "Synthetic twice".into()), (3, "Synthetic twice".into())]
    );
}
