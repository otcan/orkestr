//! Conversation settings reach Deep turns as launch parameters at dispatch.
use super::*;
use orkestr_v2_contracts::ConversationProvider;

async fn deep(w: &Window, key: &str) -> ConsumedProviderDispatch {
    let claim = w
        .bound
        .claim_next(
            &w.f.owner,
            &w.f.conversation,
            &w.roles.deep.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let admission = w
        .bound
        .admit_run(
            &claim,
            &w.roles.deep.session_id,
            w.roles.deep.generation,
            key,
        )
        .await
        .unwrap();
    w.consume(&admission).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deep_dispatch_carries_settings_read_at_consumption() {
    let w = Window::open().await;
    w.activate().await;
    sqlx::query("INSERT INTO conversation_settings(conversation_id,owner_id,revision,provider,model,reasoning_effort,honor_no_reply,provider_generation,updated_at_ms) VALUES(?,?,3,'codex','gpt-5.1-codex','xhigh',1,0,1)")
        .bind(w.f.conversation.to_string())
        .bind(w.f.owner.to_string())
        .execute(&w.f.store.pool)
        .await
        .unwrap();
    let dispatch = deep(&w, "launch-deep").await;
    let launch = dispatch.launch().expect("deep turns carry launch settings");
    assert_eq!(launch.settings_revision, 3);
    assert_eq!(
        launch.codex_overrides(),
        Some((Some("gpt-5.1-codex"), Some("xhigh")))
    );
    assert_eq!(launch.provider, ConversationProvider::Codex);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fast_override_is_read_at_consumption_and_never_replaces_deep_launch() {
    let w = Window::open().await;
    w.activate().await;
    sqlx::query("INSERT INTO conversation_settings(conversation_id,owner_id,revision,provider,model,reasoning_effort,honor_no_reply,provider_generation,updated_at_ms) VALUES(?,?,3,'codex','gpt-6.1-sol','high',1,0,1)")
        .bind(w.f.conversation.to_string()).bind(w.f.owner.to_string()).execute(&w.f.store.pool).await.unwrap();
    let fast = w.ready_fast().await;
    let source = w
        .bound
        .next_fast_source(w.credential.credential(), &w.f.conversation, 0)
        .await
        .unwrap()
        .unwrap();
    let admission = w
        .bound
        .admit_fast(
            w.credential.credential(),
            &crate::production_runtime::FastAdmissionInput {
                source_message_id: source.message_id,
                source_event_id: source.event_id,
                fast_binding_id: fast.session_id,
                expected_binding_generation: fast.generation,
                request_key: "fast-model-admission".into(),
            },
        )
        .await
        .unwrap();
    // Update after admission: consumption freezes the latest Fast preference.
    let selected =
        w.f.store
            .update_fast_role_settings(
                &w.browser_credential,
                &w.f.owner,
                &w.f.conversation,
                &orkestr_v2_contracts::FastRoleSettingsUpdate {
                    expected_revision: 0,
                    model: Some("gpt-6-luna".into()),
                    reasoning_effort: Some("low".into()),
                    parallel_replies: None,
                },
            )
            .await
            .unwrap();
    let dispatch = w.consume(&admission).await;
    assert_eq!(
        dispatch.launch().unwrap().codex_overrides(),
        Some((Some("gpt-6-luna"), Some("low")))
    );
    assert_eq!(
        dispatch.launch().unwrap().settings_revision,
        selected.revision
    );
    let deep_dispatch = deep(&w, "deep-keeps-model").await;
    assert_eq!(
        deep_dispatch.launch().unwrap().codex_overrides(),
        Some((Some("gpt-6.1-sol"), Some("high")))
    );
}
