use orkestr_v2_contracts::{ConversationSnapshot, Message, MessageRevisionSource};
use orkestr_v2_ui::chat_timeline::{ordered, Input, Row};
use orkestr_v2_ui::Projection;
use serde_json::{json, Value};

fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}
fn change(revision: i64, kind: &str, text: Option<&str>) -> Value {
    json!({"revision": revision, "kind": kind, "text": text, "source": "web", "revised_at_ms": 1})
}
fn row(sequence: i64, text: &str, revisions: Value) -> Value {
    json!({"message_id": id(sequence as u32), "sequence": sequence, "actor_kind": "owner", "text": text, "revisions": revisions})
}
fn notice(sequence: i64, target: i64, change: Value, agent_notified: bool) -> Value {
    row(
        sequence,
        "[Message corrected] synthetic",
        json!({"can_revise": false, "notice_for": {"target_message_id": id(target as u32), "change": change, "agent_notified": agent_notified, "agent_saw_earlier_text": true}}),
    )
}
fn page(rows: Vec<Value>, last: i64) -> ConversationSnapshot {
    serde_json::from_value(json!({"conversation_id": id(900), "scope": {"kind": "global"}, "messages": rows, "last_sequence": last, "next_cursor": null})).unwrap()
}
fn message(value: Value) -> Message {
    serde_json::from_value(value).unwrap()
}
fn shown(view: &Projection, sequence: i64) -> Input {
    Input::from(view.messages.get(&sequence).unwrap())
}

#[test]
fn an_edit_shows_the_new_text_over_the_immutable_original() {
    let input = Input::from(&message(row(
        1,
        "original",
        json!({"can_revise": true, "latest": change(2, "edit", Some("corrected"))}),
    )));
    assert_eq!(input.text, "corrected");
    assert_eq!(input.revisions.revision, 2);
    assert_eq!(
        input.revisions.edited_from,
        Some(MessageRevisionSource::Web)
    );
    assert!(input.revisions.can_revise);
    assert!(!input.revisions.deleted);
}

#[test]
fn a_removal_hides_the_text_and_the_controls() {
    let input = Input::from(&message(row(
        1,
        "private text",
        json!({"can_revise": true, "latest": change(1, "delete", None)}),
    )));
    assert_eq!(input.text, "");
    assert!(input.revisions.deleted);
    assert!(!input.revisions.can_revise);
    assert_eq!(input.revisions.edited_from, None);
    let rows = ordered(&[input], &[], &[]).unwrap();
    assert!(!rows[0].is_replyable());
}

#[test]
fn a_message_the_server_does_not_mark_offers_no_controls() {
    let input = Input::from(&message(
        json!({"message_id": id(1), "sequence": 1, "actor_kind": "owner", "text": "member"}),
    ));
    assert!(!input.revisions.can_revise);
    assert_eq!(input.text, "member");
}

#[test]
fn a_catch_up_notice_updates_the_older_row_it_names() {
    let mut view = Projection::default();
    view.page(page(
        vec![row(1, "original", json!({"can_revise": true}))],
        1,
    ))
    .unwrap();
    view.page(page(
        vec![notice(2, 1, change(1, "edit", Some("corrected")), true)],
        2,
    ))
    .unwrap();
    assert_eq!(shown(&view, 1).text, "corrected");
    let notice_row = shown(&view, 2);
    assert!(notice_row.revisions.notice.is_some());
    assert!(!notice_row.revisions.can_revise);
    view.page(page(vec![notice(3, 1, change(2, "delete", None), true)], 3))
        .unwrap();
    let target = shown(&view, 1);
    assert!(target.revisions.deleted);
    assert!(!target.revisions.can_revise);
    assert_eq!(view.messages.get(&1).unwrap().text, "original");
}

#[test]
fn an_older_notice_cannot_undo_a_newer_change() {
    let mut view = Projection::default();
    view.page(page(
        vec![row(
            1,
            "original",
            json!({"can_revise": true, "latest": change(2, "edit", Some("newest"))}),
        )],
        1,
    ))
    .unwrap();
    view.page(page(
        vec![notice(2, 1, change(1, "edit", Some("older")), true)],
        2,
    ))
    .unwrap();
    assert_eq!(shown(&view, 1).text, "newest");
}

#[test]
fn a_page_replayed_with_a_revision_is_not_a_conflict() {
    let mut view = Projection::default();
    view.page(page(
        vec![row(1, "original", json!({"can_revise": true}))],
        1,
    ))
    .unwrap();
    view.page(page(
        vec![row(
            1,
            "original",
            json!({"can_revise": true, "latest": change(1, "edit", Some("corrected"))}),
        )],
        1,
    ))
    .unwrap();
    assert_eq!(shown(&view, 1).text, "corrected");
}

#[test]
fn a_change_to_one_merged_part_leaves_the_shown_text_alone() {
    let mut view = Projection::default();
    view.page(page(vec![row(1, "merged", json!({"can_revise": true}))], 1))
        .unwrap();
    let part = row(
        2,
        "[Message corrected] synthetic",
        json!({"can_revise": false, "notice_for": {"target_message_id": id(1), "change": change(1, "delete", None), "agent_notified": true, "agent_saw_earlier_text": true, "part": true}}),
    );
    view.page(page(vec![part], 2)).unwrap();
    let target = shown(&view, 1);
    assert_eq!(target.text, "merged");
    assert!(!target.revisions.deleted);
    assert!(target.revisions.can_revise);
}

#[test]
fn only_a_removal_the_agent_never_saw_is_left_out_of_the_chat() {
    let told = Input::from(&message(notice(2, 1, change(1, "delete", None), true)));
    let silent = Input::from(&message(notice(3, 1, change(1, "delete", None), false)));
    let rows = ordered(&[told, silent], &[], &[]).unwrap();
    assert!(rows[0].is_notice() && !rows[0].is_silent_notice());
    assert!(rows[1].is_silent_notice());
    assert!(matches!(rows[0], Row::Input(_)) && !rows[0].is_replyable());
}
