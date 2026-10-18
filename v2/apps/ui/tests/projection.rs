use orkestr_v2_contracts::ConversationSnapshot;
use orkestr_v2_ui::{Draft, Projection, WINDOW};

#[test]
fn intake_fixture_is_not_a_model_response() {
    let snapshot: ConversationSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/conversation-snapshot.json")).unwrap();
    let mut projection = Projection::default();
    projection.page(snapshot.clone()).unwrap();
    projection.page(snapshot).unwrap();
    assert_eq!(projection.messages.len(), 1);
    assert_eq!(projection.messages[&1].actor_kind, "owner");
}

#[test]
fn uncertain_retry_keeps_key_and_text_while_followup_stays_editable() {
    let mut draft = Draft::default();
    draft.edit("First 日本語".into());
    let first = draft.prepare("request-1".into()).unwrap();
    draft.edit("Follow-up".into());
    let retry = draft.prepare("ignored-new-key".into()).unwrap();
    assert_eq!(first.client_message_id, retry.client_message_id);
    assert_eq!(first.text, retry.text);
    draft.accepted();
    assert_eq!(draft.text, "Follow-up");
    assert_eq!(draft.prepare("request-2".into()).unwrap().text, "Follow-up");
}

#[test]
fn unchanged_accepted_draft_clears_and_utf8_limit_is_bytes() {
    let mut draft = Draft::default();
    draft.edit("hello".into());
    draft.prepare("key".into()).unwrap();
    draft.accepted();
    assert!(draft.text.is_empty());
    draft.edit("👋".repeat(8193));
    assert!(draft.prepare("key2".into()).is_err());
}

#[test]
fn bounded_paginated_projection_and_conflicting_replay() {
    let base: ConversationSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/conversation-snapshot.json")).unwrap();
    let mut view = Projection::default();
    for sequence in 1..=10000 {
        let mut page = base.clone();
        page.last_sequence = 10000;
        page.messages[0].sequence = sequence;
        view.page(page).unwrap();
    }
    assert_eq!(view.messages.len(), WINDOW);
    assert_eq!(*view.messages.first_key_value().unwrap().0, 9901);
    let mut conflict = base;
    conflict.last_sequence = 10000;
    conflict.messages[0].sequence = 10000;
    conflict.messages[0].text = "changed".into();
    assert!(view.page(conflict).is_err());
}

#[test]
fn sparse_sequences_and_empty_delta_advance_authoritative_watermark() {
    let mut page: ConversationSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/conversation-snapshot.json")).unwrap();
    page.messages[0].sequence = 7;
    page.last_sequence = 12;
    let mut view = Projection::default();
    view.page(page.clone()).unwrap();
    assert_eq!(view.watermark, 12);
    assert_eq!(view.messages.len(), 1);
    page.messages.clear();
    page.last_sequence = 19;
    view.page(page).unwrap();
    assert_eq!(view.watermark, 19);
    assert!(view.messages.contains_key(&7));
}

#[test]
fn invalid_late_message_rejects_whole_page_without_advancing_cursor() {
    let mut page: ConversationSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/conversation-snapshot.json")).unwrap();
    let mut view = Projection::default();
    view.page(page.clone()).unwrap();
    page.last_sequence = 3;
    page.messages[0].sequence = 2;
    let mut invalid = page.messages[0].clone();
    invalid.sequence = 4;
    page.messages.push(invalid);
    assert!(view.page(page).is_err());
    assert_eq!(view.watermark, 1);
    assert_eq!(view.messages.len(), 1);
    assert!(!view.messages.contains_key(&2));
}

#[test]
fn conflicting_duplicates_inside_one_page_are_not_last_write_wins() {
    let mut page: ConversationSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/conversation-snapshot.json")).unwrap();
    let mut conflicting = page.messages[0].clone();
    conflicting.actor_kind = "assistant".into();
    page.messages.push(conflicting);
    let mut view = Projection::default();
    assert!(view.page(page).is_err());
    assert!(view.messages.is_empty());
    assert_eq!(view.watermark, 0);
}
