use orkestr_v2_contracts::{ConversationProvider, ConversationSettings};
use orkestr_v2_ui::chat_settings::{slugs, SettingsForm};

fn settings() -> ConversationSettings {
    serde_json::from_value(serde_json::json!({
        "schema_version": 1, "conversation_id": "00000000-0000-4000-8000-000000000001", "revision": 3,
        "provider": "codex", "model": "synthetic-model", "reasoning_effort": "xhigh", "honor_no_reply": true,
        "reply_prefix": "synthetic:", "reply_footer": null, "provider_generation": 0, "updated_at_ms": 1
    }))
    .unwrap()
}

#[test]
fn the_form_round_trips_and_guards_the_revision() {
    let mut form = SettingsForm::from_settings(&settings());
    let update = form.update().unwrap();
    assert_eq!(
        (
            update.expected_revision,
            update.model.as_deref(),
            update.reasoning_effort.as_deref()
        ),
        (3, Some("synthetic-model"), Some("xhigh"))
    );
    assert_eq!(update.reply_prefix.as_deref(), Some("synthetic:"));
    form.set_provider(ConversationProvider::Claude);
    assert_eq!(form.effort, "", "xhigh is not a Claude effort");
    form.effort = "max".into();
    form.model = " ".into();
    let update = form.update().unwrap();
    assert_eq!(
        (update.model, update.reasoning_effort.as_deref()),
        (None, Some("max"))
    );
    form.model = "bad model".into();
    assert!(form.update().is_err());
}

#[test]
fn slugs_are_split_and_deduplicated() {
    assert_eq!(
        slugs("sales-nav, gmail  sales-nav\nlinkedin"),
        vec!["sales-nav", "gmail", "linkedin"]
    );
    assert!(slugs(" , ").is_empty());
}
