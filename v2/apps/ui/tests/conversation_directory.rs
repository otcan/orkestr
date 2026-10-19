use orkestr_v2_contracts::Scope;
use orkestr_v2_ui::conversation_directory::{
    valid_name, ConversationPage, ConversationSummary, Creation,
};
use serde_json::json;

fn row(name: &str) -> ConversationSummary {
    serde_json::from_value(json!({"conversation_id":"00000000-0000-4000-8000-000000000001", "name":name,"scope":{"kind":"global"},"last_sequence":7})).unwrap()
}

#[test]
fn create_retry_keeps_original_name_and_key_until_confirmed() {
    let mut state = Creation {
        name: "  Research notes  ".into(),
        ..Default::default()
    };
    let first = state.prepare("synthetic-one".into()).unwrap();
    state.name = "A later edit".into();
    let retry = state.prepare("synthetic-two".into()).unwrap();
    assert_eq!(first.client_request_id, retry.client_request_id);
    assert_eq!(retry.name, "Research notes");
    assert!(state.confirmed(&row("Research notes")));
    assert!(!state.confirmed(&row("A later edit")));
    let mut foreign = row("Research notes");
    foreign.conversation_id =
        serde_json::from_value(json!("00000000-0000-0000-0000-000000000000")).unwrap();
    assert!(!state.confirmed(&foreign));
}

#[test]
fn names_use_unicode_scalars_and_reject_control_characters() {
    assert!(valid_name(&"🦀".repeat(120)));
    assert!(!valid_name(&"🦀".repeat(121)));
    for name in ["", " ", " leading", "trailing ", "line\nbreak", "nul\0"] {
        assert!(!valid_name(name));
    }
    assert_eq!(row("Research notes").scope, Scope::Global);
}

#[test]
fn directory_cursor_is_not_the_conversation_event_watermark() {
    let mut page = ConversationPage {
        conversations: vec![row("Notes")],
        next_cursor: Some(100),
    };
    assert!(page.valid(99)); // last_sequence=7 is unrelated to the directory cursor.
    page.next_cursor = Some(99);
    assert!(!page.valid(99));
    page.next_cursor = Some(100);
    page.conversations.push(row("Duplicate identity"));
    assert!(!page.valid(99));
    page.conversations.clear();
    assert!(!page.valid(99));
}
