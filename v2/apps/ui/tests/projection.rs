use orkestr_v2_ui::{Draft, Projection, WINDOW};
use orkestr_v2_contracts::ConversationSnapshot;

#[test]
fn intake_fixture_is_not_a_model_response() {
    let snapshot: ConversationSnapshot = serde_json::from_str(include_str!("../../../fixtures/conversation-snapshot.json")).unwrap();
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
    let base: ConversationSnapshot = serde_json::from_str(include_str!("../../../fixtures/conversation-snapshot.json")).unwrap();
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
