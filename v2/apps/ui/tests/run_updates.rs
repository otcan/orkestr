use orkestr_v2_contracts::{AcceptedResult, RunUpdate, RunUpdates};
use orkestr_v2_ui::chat_timeline::{ordered_with_updates, Input, Row};
use orkestr_v2_ui::run_updates::*;
use serde_json::json;
use std::collections::BTreeMap;

const CHAT: &str = "00000000-0000-4000-8000-00000000000a";

fn update(sequence: i64, payload: u8, final_answer: bool) -> RunUpdate {
    serde_json::from_value(json!({"run_id":"00000000-0000-4000-8000-000000000001",
        "payload_id": format!("00000000-0000-4000-8000-0000000001{payload:02}"),
        "sequence": sequence, "observed_at_ms": 1_700_000_000_000_i64,
        "payload_removed": false, "final_answer": final_answer}))
    .unwrap()
}
fn reply(sequence: i64, payload: u8) -> AcceptedResult {
    serde_json::from_value(json!({"run_id":"00000000-0000-4000-8000-000000000001",
        "completion_event_id":"00000000-0000-4000-8000-000000000002",
        "acceptance_event_id":"00000000-0000-4000-8000-000000000003", "acceptance_sequence": sequence,
        "payload_id": format!("00000000-0000-4000-8000-0000000001{payload:02}"), "payload_removed": false}))
    .unwrap()
}
fn input(sequence: i64) -> Input {
    Input {
        id: format!("input-{sequence}"),
        sequence,
        actor: "owner".into(),
        text: "Question".into(),
        reply_to: None,
        revisions: Default::default(),
    }
}
fn page(updates: Vec<RunUpdate>, next: Option<i64>) -> RunUpdates {
    RunUpdates {
        conversation_id: serde_json::from_value(json!(CHAT)).unwrap(),
        updates,
        next_after_sequence: next,
    }
}

#[test]
fn every_update_is_its_own_message_in_event_order_and_the_answer_once() {
    // Input 1, updates at 3 and 4, the answer's payload at 5 (final), its
    // accepted reply at 7; a second input arrived at 6 while the run worked.
    let updates = [update(3, 1, false), update(4, 2, false), update(5, 3, true)];
    let replies = [reply(7, 3)];
    let visible = shown(&updates, &replies, 1);
    assert_eq!(
        visible.iter().map(|u| u.sequence).collect::<Vec<_>>(),
        [3, 4],
        "the final answer is not an update"
    );
    let rows = ordered_with_updates(&[input(1), input(6)], &replies, &[], &visible).unwrap();
    let kinds: Vec<String> = rows
        .iter()
        .map(|row| match row {
            Row::Input(i) => format!("in{}", i.sequence),
            Row::Update(u) => format!("up{}", u.sequence),
            Row::Reply(r) => format!("final{}", r.acceptance_sequence),
            Row::Post(_) => "post".into(),
        })
        .collect();
    assert_eq!(kinds, ["in1", "up3", "up4", "in6", "final7"]);
    assert!(rows.iter().all(|row| row.is_replyable()));
    assert_eq!(rows[1].key(), "update-00000000-0000-4000-8000-000000000101");
}

#[test]
fn an_answer_accepted_after_the_list_was_read_is_still_shown_once() {
    // The list still says "not final", but the accepted reply names it.
    let updates = [update(3, 1, false), update(5, 3, false)];
    let visible = shown(&updates, &[reply(7, 3)], 1);
    assert_eq!(visible.iter().map(|u| u.sequence).collect::<Vec<_>>(), [3]);
    // While the run works, every update shows, its newest included.
    assert_eq!(shown(&updates, &[], 0).len(), 2);
    // Removed texts and updates older than the oldest message on screen do not show.
    let mut removed = update(4, 2, false);
    removed.payload_removed = true;
    assert!(shown(&[removed], &[], 1).is_empty());
    assert!(shown(&[update(3, 1, false)], &[], 10).is_empty());
}

#[test]
fn pages_are_checked_and_merged_without_identity_changes() {
    assert!(valid_forward(
        &page(vec![update(3, 1, false)], None),
        CHAT,
        2
    ));
    assert!(!valid_forward(
        &page(vec![update(3, 1, false)], None),
        CHAT,
        3
    ));
    assert!(!valid_forward(
        &page(vec![update(3, 1, false)], None),
        "00000000-0000-4000-8000-00000000000b",
        0
    ));
    assert!(valid_newest(
        &page(vec![update(3, 1, false)], None),
        CHAT,
        4
    ));
    assert!(!valid_newest(
        &page(vec![update(3, 1, false)], Some(3)),
        CHAT,
        4
    ));
    assert!(!valid_newest(
        &page(vec![update(3, 1, false)], None),
        CHAT,
        3
    ));
    assert_eq!(older_cursor(&page(vec![update(3, 1, false)], None)), None);
    let full: Vec<RunUpdate> = (1..=100).map(|n| update(n + 10, 1, false)).collect();
    assert_eq!(older_cursor(&page(full, None)), Some(11));
    let mut rows = BTreeMap::new();
    merge(&mut rows, &[update(3, 1, false), update(4, 2, false)]).unwrap();
    let mut removed = update(3, 1, false);
    removed.payload_removed = true;
    merge(&mut rows, &[removed]).unwrap();
    merge(&mut rows, &[update(3, 1, true)]).unwrap();
    assert!(rows[&3].payload_removed, "a removal stays");
    assert!(rows[&3].final_answer, "marks may change");
    assert!(
        merge(&mut rows, &[update(3, 9, false)]).is_err(),
        "another payload at a known place"
    );
    let many: Vec<RunUpdate> = (1..=(UPDATES_KEPT as i64 + 5))
        .map(|n| update(n + 100, 1, false))
        .collect();
    merge(&mut rows, &many).unwrap();
    assert_eq!(rows.len(), UPDATES_KEPT);
    assert_eq!(rows.keys().next_back(), Some(&(UPDATES_KEPT as i64 + 105)));
}

#[test]
fn the_reader_reads_an_update_by_payload_and_silences_it_by_sequence() {
    let row = reader_row(&update(3, 1, false));
    assert_eq!(row.acceptance_sequence, 3);
    assert_eq!(
        row.payload_id.unwrap().to_string(),
        "00000000-0000-4000-8000-000000000101"
    );
    assert_eq!(
        newest_path(CHAT, i64::MAX),
        format!(
            "/api/v2/conversations/{CHAT}/updates?before_sequence=9223372036854775807&limit=100"
        )
    );
    assert_eq!(
        after_path(CHAT, 5),
        format!("/api/v2/conversations/{CHAT}/updates?after_sequence=5&limit=100")
    );
}
