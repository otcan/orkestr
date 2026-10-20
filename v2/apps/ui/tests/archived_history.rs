use orkestr_v2_contracts::ArchivedHistoryPage;
use orkestr_v2_ui::archived_history::{
    preview, role_label, ArchivedTimeline, PREVIEW_CHARS, RETAINED,
};
use serde_json::{json, Value};

const ID: &str = "00000000-0000-4000-8000-000000000001";

fn entry(sequence: i64, text: &str) -> Value {
    json!({"archive_sequence":sequence,"source_instance":"synthetic-v1","source_thread_id":"thread-a","snapshot_id":"snap-1",
        "message":{"source_message_id":format!("m{sequence}"),"source_position":sequence,"source_cursor":sequence,"role":if sequence % 2 == 0 {"assistant"} else {"user"},
        "phase":null,"state":"done","source_kind":null,"created_at":"2026-01-01T00:00:00Z","updated_at":null,"text":text,"attachments":[]}})
}
fn page(conversation: &str, entries: Vec<Value>, next: Option<i64>) -> ArchivedHistoryPage {
    serde_json::from_value(
        json!({"conversation_id":conversation,"entries":entries,"next_after":next}),
    )
    .unwrap()
}

#[test]
fn pages_append_in_archive_order_until_exhausted() {
    let mut timeline = ArchivedTimeline::new(ID);
    assert_eq!(timeline.cursor(), Some(0));
    timeline
        .apply(
            0,
            page(ID, vec![entry(1, "hello"), entry(2, "hi")], Some(2)),
        )
        .unwrap();
    assert_eq!(timeline.cursor(), Some(2));
    timeline
        .apply(2, page(ID, vec![entry(3, "later")], None))
        .unwrap();
    assert_eq!(timeline.cursor(), None);
    let texts: Vec<_> = timeline
        .entries()
        .map(|e| e.message.text.as_str())
        .collect();
    assert_eq!(texts, ["hello", "hi", "later"]);
}

#[test]
fn empty_archive_is_loaded_and_exhausted() {
    let mut timeline = ArchivedTimeline::new(ID);
    timeline.apply(0, page(ID, vec![], None)).unwrap();
    assert!(timeline.loaded() && timeline.is_empty() && timeline.cursor().is_none());
}

#[test]
fn foreign_reordered_stale_or_invalid_pages_fail_closed() {
    let other = "00000000-0000-4000-8000-000000000002";
    let mut timeline = ArchivedTimeline::new(ID);
    assert!(timeline
        .apply(0, page(other, vec![entry(1, "x")], None))
        .is_err());
    assert!(timeline
        .apply(0, page(ID, vec![entry(2, "b"), entry(1, "a")], None))
        .is_err());
    assert!(timeline
        .apply(5, page(ID, vec![entry(6, "x")], None))
        .is_err());
    assert!(timeline.apply(0, page(ID, vec![], Some(3))).is_err());
    let mut bad = entry(1, "x");
    bad["message"]["role"] = json!("User!");
    assert!(timeline.apply(0, page(ID, vec![bad], None)).is_err());
    assert!(!timeline.loaded());
    timeline
        .apply(0, page(ID, vec![entry(1, "a")], Some(1)))
        .unwrap();
    assert!(
        timeline
            .apply(0, page(ID, vec![entry(1, "a")], None))
            .is_err(),
        "replayed cursor"
    );
}

#[test]
fn retention_is_bounded_and_reported() {
    let mut timeline = ArchivedTimeline::new(ID);
    let mut after = 0;
    while timeline.len() < RETAINED || !timeline.trimmed() {
        let rows = (after + 1..=after + 100).map(|s| entry(s, "x")).collect();
        timeline
            .apply(after, page(ID, rows, Some(after + 100)))
            .unwrap();
        after += 100;
    }
    assert_eq!(timeline.len(), RETAINED);
    assert_eq!(
        timeline.entries().next().unwrap().archive_sequence,
        after - RETAINED as i64 + 1
    );
}

#[test]
fn labels_and_previews_never_drop_text_silently() {
    assert_eq!(role_label("user"), "You");
    assert_eq!(role_label("assistant"), "Assistant");
    assert_eq!(role_label("worker-1"), "worker-1");
    let long = "é".repeat(PREVIEW_CHARS + 3);
    let (head, cut) = preview(&long);
    assert!(cut);
    assert_eq!(head.chars().count(), PREVIEW_CHARS);
    assert_eq!(preview("short"), ("short", false));
}
