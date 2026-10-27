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
fn review_before_accepting_defaults_off_and_round_trips() {
    let form = SettingsForm::from_settings(&settings());
    assert!(!form.review_before_accepting, "auto-accept is the default");
    assert!(!form.update().unwrap().review_before_accepting);
    let mut value = settings();
    value.review_before_accepting = true;
    let mut form = SettingsForm::from_settings(&value);
    assert!(form.update().unwrap().review_before_accepting);
    form.review_before_accepting = false;
    assert!(!form.update().unwrap().review_before_accepting);
}

#[test]
fn parallel_deep_defaults_off_and_is_sent_only_when_changed() {
    let mut form = SettingsForm::from_settings(&settings());
    assert!(
        !form.parallel_deep,
        "one Deep turn at a time is the default"
    );
    assert_eq!(
        form.update().unwrap().parallel_deep,
        None,
        "unchanged: omitted"
    );
    form.parallel_deep = true;
    assert_eq!(form.update().unwrap().parallel_deep, Some(true));
    let mut value = settings();
    value.parallel_deep = true;
    let mut form = SettingsForm::from_settings(&value);
    assert_eq!(form.update().unwrap().parallel_deep, None);
    form.parallel_deep = false;
    assert_eq!(form.update().unwrap().parallel_deep, Some(false));
}

#[test]
fn slugs_are_split_and_deduplicated() {
    assert_eq!(
        slugs("sales-nav, gmail  sales-nav\nlinkedin"),
        vec!["sales-nav", "gmail", "linkedin"]
    );
    assert!(slugs(" , ").is_empty());
}

#[test]
fn only_known_settings_without_review_auto_accept() {
    use orkestr_v2_ui::chat_settings::auto_accepts;
    assert!(
        !auto_accepts(None),
        "unknown settings keep the Accept prompt"
    );
    let mut value = settings();
    assert!(auto_accepts(Some(&value)));
    value.review_before_accepting = true;
    assert!(!auto_accepts(Some(&value)));
}
