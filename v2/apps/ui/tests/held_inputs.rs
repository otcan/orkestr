use orkestr_v2_contracts::HeldOwnerInputPage;
use orkestr_v2_ui::held_inputs::{
    fresh_input_notice, reason, HeldInputs, CANCEL_UNAVAILABLE, RESUME_UNAVAILABLE,
};
fn page() -> HeldOwnerInputPage {
    serde_json::from_value(serde_json::json!({"schema_version":1,
        "conversation_id":"00000000-0000-4000-8000-000000000001","revision":10,"observed_at_ms":1000,
        "held":[{"message_id":"00000000-0000-4000-8000-000000000002",
        "source_event_id":"00000000-0000-4000-8000-000000000003","scope_sequence":4,
        "reason":"stop_boundary","boundary_run_id":"00000000-0000-4000-8000-000000000005",
        "boundary_event_id":"00000000-0000-4000-8000-000000000006","through_scope_sequence":8}],
        "next_after_sequence":null,"eligible_input_available":false})).unwrap()
}
#[test]
fn fresh_input_never_releases_hold_or_enables_resume_cancel() {
    let mut state = HeldInputs::default();
    let original = page();
    let read = state.begin(original.conversation_id.clone(), 0);
    state.apply(&read, 1, original.clone()).unwrap();
    let mut fresh = original.clone();
    fresh.revision += 1;
    fresh.observed_at_ms += 1;
    fresh.eligible_input_available = true;
    state.apply(&read, 2, fresh.clone()).unwrap();
    assert_eq!(state.displayed_page().unwrap().held, original.held);
    assert!(fresh_input_notice(&fresh).contains("older held input stays held"));
    assert!(reason(&original.held[0]).contains("not automatically replayed"));
    assert!(RESUME_UNAVAILABLE.contains("unavailable"));
    assert!(CANCEL_UNAVAILABLE.contains("remains saved"));
}
#[test]
fn owner_navigation_and_paging_fence_late_reads_without_releasing_saved_input() {
    let mut state = HeldInputs::default();
    let original = page();
    let old = state.begin(original.conversation_id.clone(), 0);
    state.apply(&old, 1, original.clone()).unwrap();
    let next = state.begin(original.conversation_id.clone(), 4);
    assert!(state.displayed_page().is_none());
    assert!(state.apply(&old, 2, original.clone()).is_err());
    assert!(state.apply(&next, 2, original.clone()).is_err());
    state.failed(&old);
    assert!(state.status(2).contains("Loading"));
    state.failed(&next);
    assert_eq!(state.displayed_page().unwrap().held, original.held);
    state.clear_owner();
    assert!(state.displayed_page().is_none());
    assert!(state.apply(&next, 3, original).is_err());
}
#[test]
fn bad_boundary_backward_revision_and_identical_replay_cannot_replace_or_refresh_hold() {
    let mut state = HeldInputs::default();
    let original = page();
    let read = state.begin(original.conversation_id.clone(), 0);
    state.apply(&read, 1, original.clone()).unwrap();
    for n in 0..4 {
        let mut bad = original.clone();
        match n {
            0 => bad.held[0].through_scope_sequence = 3,
            1 => bad.held.push(bad.held[0].clone()),
            2 => bad.revision = 9,
            _ => bad.next_after_sequence = Some(99),
        };
        assert!(state.apply(&read, 2, bad).is_err());
        assert_eq!(state.displayed_page(), Some(&original));
    }
    let refresh = state.begin(original.conversation_id.clone(), 0);
    state.apply(&refresh, 60001, original).unwrap();
    assert!(state.status(60001).contains("stale"));
}

#[test]
fn preview_uses_only_exact_loaded_conversation_message_and_unicode_bound() {
    use orkestr_v2_ui::{held_inputs::saved_preview, Projection};
    let conversation: orkestr_v2_contracts::ConversationId =
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000001")).unwrap();
    let message =
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000002")).unwrap();
    let mut projection = Projection {
        conversation_id: Some(conversation.to_string()),
        ..Projection::default()
    };
    projection.messages.insert(
        1,
        orkestr_v2_contracts::Message {
            message_id: message,
            sequence: 1,
            actor_kind: "owner".into(),
            text: "é".repeat(200),
            reply_to: None,
            origin: None,
        },
    );
    let message = &projection.messages[&1].message_id;
    assert_eq!(
        saved_preview(&projection, &conversation, message).unwrap(),
        format!("{}…", "é".repeat(180))
    );
    let other =
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000003")).unwrap();
    assert!(saved_preview(&projection, &other, message).is_none());
    let missing =
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000004")).unwrap();
    assert!(saved_preview(&projection, &conversation, &missing).is_none());
    assert_eq!(projection.messages.len(), 1);
}
