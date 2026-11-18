use orkestr_v2_contracts::{ConversationProvider, ConversationSettings, FastRoleSettings};
use orkestr_v2_ui::model_settings::{
    deep_suggestions, heading_label, heading_title, observed_model, same_model, FastForm, RoleModel,
};
use serde_json::json;

fn deep(model: Option<&str>, effort: Option<&str>) -> ConversationSettings {
    serde_json::from_value(json!({
        "schema_version": 1, "conversation_id": "00000000-0000-4000-8000-000000000001", "revision": 4,
        "provider": "codex", "model": model, "reasoning_effort": effort, "honor_no_reply": true,
        "reply_prefix": null, "reply_footer": null, "provider_generation": 0, "updated_at_ms": 1
    }))
    .unwrap()
}

fn fast(revision: i64, model: Option<&str>, effort: Option<&str>) -> FastRoleSettings {
    serde_json::from_value(json!({
        "schema_version": 1, "conversation_id": "00000000-0000-4000-8000-000000000001",
        "revision": revision, "model": model, "reasoning_effort": effort,
        "parallel_replies": false, "updated_at_ms": null
    }))
    .unwrap()
}

#[test]
fn an_unset_deep_model_names_what_the_last_reply_used() {
    let role = RoleModel::deep(&deep(None, None), Some("gpt-6.1-terra".into()));
    assert_eq!(role.model_text(), "gpt-6.1-terra (default)");
    assert_eq!(role.effort_text(), "default");
    assert_eq!(role.short(), "gpt-6.1-terra");
    assert_eq!(role.drift(), None, "the installation decides; no drift");
    let unknown = RoleModel::deep(&deep(None, None), None);
    assert_eq!(unknown.model_text(), "installation default");
    assert_eq!(unknown.last_text(), "not reported yet");
    assert_eq!(unknown.short(), "default");
}

#[test]
fn a_chosen_deep_model_is_shown_and_a_different_last_reply_is_flagged() {
    let role = RoleModel::deep(
        &deep(Some("gpt-6.1-sol"), Some("high")),
        Some("gpt-6.1-terra".into()),
    );
    assert_eq!(
        (role.model_text(), role.effort_text(), role.short()),
        (
            "gpt-6.1-sol".to_owned(),
            "high".to_owned(),
            "gpt-6.1-sol · high".to_owned()
        )
    );
    assert_eq!(
        role.drift().as_deref(),
        Some("Deep: the last reply used gpt-6.1-terra; the next turn asks for gpt-6.1-sol.")
    );
    let settled = RoleModel::deep(&deep(Some("gpt-6.1-sol"), None), Some("gpt-6.1-sol".into()));
    assert_eq!(settled.drift(), None);
}

#[test]
fn a_family_alias_matches_its_reported_model() {
    assert!(same_model("opus", "claude-opus-5-5"));
    assert!(same_model("gpt-6.1-sol", "gpt-6.1-sol"));
    assert!(!same_model("gpt-6-sol", "gpt-6.1-sol"));
    assert!(!same_model("sol", "gpt-6.1-solar"));
    let mut claude = deep(Some("opus"), Some("max"));
    claude.provider = ConversationProvider::Claude;
    let role = RoleModel::deep(&claude, Some("claude-opus-5-5".into()));
    assert_eq!(role.drift(), None);
}

#[test]
fn codex_fast_shows_its_defaults_and_the_owner_choice() {
    let base = deep(Some("gpt-6.1-sol"), Some("high"));
    let unset = RoleModel::fast(&base, Some(&fast(0, None, None)), None);
    assert_eq!(
        (unset.model_text(), unset.effort_text(), unset.short()),
        (
            "gpt-6-luna (default)".to_owned(),
            "low (default)".to_owned(),
            "gpt-6-luna".to_owned()
        )
    );
    let chosen = RoleModel::fast(
        &base,
        Some(&fast(2, Some("gpt-6-sol"), Some("medium"))),
        Some("gpt-6-luna".into()),
    );
    assert_eq!(chosen.short(), "gpt-6-sol · medium");
    assert!(chosen
        .drift()
        .unwrap()
        .starts_with("Fast: the last reply used gpt-6-luna"));
}

#[test]
fn claude_fast_ignores_codex_preferences() {
    let mut base = deep(Some("opus"), Some("high"));
    base.provider = ConversationProvider::Claude;
    let role = RoleModel::fast(
        &base,
        Some(&fast(1, Some("gpt-6-sol"), Some("high"))),
        Some("claude-sonnet-5-5".into()),
    );
    assert_eq!(role.provider, ConversationProvider::Claude);
    assert_eq!(
        (role.model_text(), role.effort_text()),
        ("sonnet (default)".to_owned(), "low (default)".to_owned())
    );
    assert_eq!(role.drift(), None);
}

#[test]
fn the_heading_names_both_roles_in_short_and_in_words() {
    let base = deep(Some("gpt-6.1-sol"), Some("high"));
    let deep_role = RoleModel::deep(&base, None);
    let fast_role = RoleModel::fast(&base, Some(&fast(0, None, None)), None);
    assert_eq!(
        heading_label(&deep_role, Some(&fast_role)),
        "Deep gpt-6.1-sol · high | Fast gpt-6-luna"
    );
    assert_eq!(heading_label(&deep_role, None), "Deep gpt-6.1-sol · high");
    assert_eq!(
        heading_title(&deep_role, Some(&fast_role)),
        "Deep: codex, model gpt-6.1-sol, effort high. Fast: codex, model gpt-6-luna (default), effort low (default). Open chat settings to change."
    );
}

#[test]
fn the_reported_model_prefers_the_answer_and_ignores_refusals() {
    assert_eq!(
        observed_model(
            &json!({"models": {"resolved_model": "a-model", "actual_model": "b-model"}})
        )
        .as_deref(),
        Some("b-model")
    );
    assert_eq!(
        observed_model(&json!({"models": {"resolved_model": "a-model"}})).as_deref(),
        Some("a-model")
    );
    assert_eq!(
        observed_model(&json!({"models": {"refused_model": "c-model"}})),
        None
    );
    assert_eq!(observed_model(&json!({"phase": "completed"})), None);
    assert_eq!(observed_model(&serde_json::Value::Null), None);
    assert_eq!(
        observed_model(&json!({"models": {"actual_model": "bad model"}})),
        None
    );
}

#[test]
fn the_fast_form_replaces_model_and_effort_and_keeps_the_parallel_switch() {
    let mut form = FastForm::from_settings(&fast(3, Some("gpt-6-sol"), Some("medium")));
    let update = form.update().unwrap();
    let body = serde_json::to_value(&update).unwrap();
    assert!(
        body.get("parallel_replies").is_none(),
        "a model change never re-enables parallel replies"
    );
    assert_eq!(
        (
            update.expected_revision,
            update.model.as_deref(),
            update.reasoning_effort.as_deref(),
            update.parallel_replies
        ),
        (3, Some("gpt-6-sol"), Some("medium"), None)
    );
    form.model = "  ".into();
    form.effort.clear();
    let update = form.update().unwrap();
    assert_eq!((update.model, update.reasoning_effort), (None, None));
    form.model = "bad model".into();
    assert!(form.update().is_err());
    form.model = "gpt-6-luna".into();
    form.effort = "turbo".into();
    assert!(form.update().is_err());
}

#[test]
fn deep_suggestions_follow_the_provider_and_lead_with_sol() {
    assert_eq!(
        deep_suggestions(ConversationProvider::Codex)[0],
        "gpt-6.1-sol"
    );
    assert!(deep_suggestions(ConversationProvider::Claude).contains(&"opus"));
    assert!(!deep_suggestions(ConversationProvider::Claude).contains(&"gpt-6.1-sol"));
}
