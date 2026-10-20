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
