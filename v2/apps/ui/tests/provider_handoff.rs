use orkestr_v2_contracts::{ConversationSettings, ExecutionWindowStatus};
use orkestr_v2_ui::provider_handoff::HandoffForm;

fn values() -> (ConversationSettings, ExecutionWindowStatus) {
    let id = "00000000-0000-4000-8000-000000000001";
    let settings = serde_json::from_value(serde_json::json!({"schema_version":1,"conversation_id":id,
        "revision":3,"provider":"claude","model":"opus","reasoning_effort":"high",
        "honor_no_reply":true,"reply_prefix":"synthetic:","reply_footer":null,"provider_generation":3,
        "updated_at_ms":1,"review_before_accepting":false})).unwrap();
    let window = serde_json::from_value(
        serde_json::json!({"window_id":"00000000-0000-4000-8000-000000000002",
        "conversation_id":id,"generation":5,"state":"closed",
        "input_message_id":"00000000-0000-4000-8000-000000000003",
        "input_event_id":"00000000-0000-4000-8000-000000000004","predecessor_window_id":null,
        "opened_at_ms":1,"work_deadline_ms":870001,"expires_at_ms":900001,
        "limits":orkestr_v2_contracts::ExecutionWindowLimits::default()}),
    )
    .unwrap();
    (settings, window)
}

#[test]
fn form_requires_review_confirmation_exact_scope_and_closed_window() {
    let (settings, mut window) = values();
    let mut form = HandoffForm::for_settings(&settings);
    assert!(form
        .request("synthetic:handoff".into(), &settings, &window)
        .is_err());
    form.history = "Synthetic reviewed context; no actions to replay.".into();
    form.acknowledged = true;
    let request = form
        .request("synthetic:handoff".into(), &settings, &window)
        .unwrap();
    assert_eq!(request.expected_settings_revision, 3);
    assert_eq!(request.generation, 5);
    assert_eq!(request.model.as_deref(), Some("gpt-6.1-sol"));
    form.model = "fable".into();
    assert!(form
        .request("synthetic:handoff".into(), &settings, &window)
        .is_err());
    form.model = "gpt-6.1-sol".into();
    window.state = orkestr_v2_contracts::ExecutionWindowState::Active;
    assert!(form
        .request("synthetic:handoff".into(), &settings, &window)
        .is_err());
}
