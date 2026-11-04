//! Provider decisions are durable before either admission path launches.
use super::*;

fn provider_routing_policy() -> crate::beta_config::provider_routing::ProviderRouting {
    serde_json::from_value(serde_json::json!({"rules":[{
        "id":"synthetic-route", "terms":[{"text":"synthetic", "weight":3}],
        "threshold":3, "excluded":"claude", "preferred":"codex"
    }]}))
    .unwrap()
}

async fn select_synthetic_claude(f: &Fixture, conversation: &ConversationId) {
    let update = serde_json::from_value(serde_json::json!({
        "expected_revision":0,"provider":"claude","model":"synthetic-model",
        "reasoning_effort":"high","honor_no_reply":false,"reply_prefix":"kept:",
        "reply_footer":"kept footer","review_before_accepting":true
    }))
    .unwrap();
    f.store
        .update_conversation_settings(BROWSER, &f.owner, conversation, &update)
        .await
        .unwrap();
}

#[tokio::test]
async fn provider_routing_precedes_direct_admission_and_authenticates_the_input() {
    use orkestr_v2_contracts::ConversationProvider;
    let f = fixture().await;
    let conversation = f.conversation("policy-direct").await;
    select_synthetic_claude(&f, &conversation).await;
    let request = f.request(&conversation, "policy-direct").await;
    let mut controller = f.controller(8);
    controller.config.provider_routing = Some(provider_routing_policy());
    assert!(controller
        .process("foreign-browser", &f.owner, &conversation, &request)
        .await
        .is_err());
    let before = f
        .store
        .conversation_settings(BROWSER, &f.owner, &conversation)
        .await
        .unwrap();
    assert_eq!(before.provider, ConversationProvider::Claude);
    assert_eq!(f.windows(&conversation).await, 0);
    // No manager exists: a transport failure cannot undo the earlier durable
    // route, and no provider process is needed to test the admission boundary.
    let _ = controller
        .process(BROWSER, &f.owner, &conversation, &request)
        .await;
    let after = f
        .store
        .conversation_settings(BROWSER, &f.owner, &conversation)
        .await
        .unwrap();
    assert_eq!(after.provider, ConversationProvider::Codex);
    assert_eq!(after.revision, before.revision + 1);
    assert!(after.model.is_none());
    assert!(after.reasoning_effort.is_none());
    assert_eq!(after.reply_prefix, before.reply_prefix);
    assert_eq!(after.reply_footer, before.reply_footer);
    assert_eq!(after.honor_no_reply, before.honor_no_reply);
    assert_eq!(
        after.review_before_accepting,
        before.review_before_accepting
    );
}

#[tokio::test]
async fn provider_routing_also_precedes_durable_queue_dispatch() {
    use orkestr_v2_contracts::ConversationProvider;
    let f = fixture().await;
    let conversation = f.conversation("policy-queued").await;
    select_synthetic_claude(&f, &conversation).await;
    let request = f.request(&conversation, "policy-queued").await;
    f.store
        .enqueue_execution_window_authenticated(BROWSER, &conversation, &request)
        .await
        .unwrap();
    let mut controller = f.controller(8);
    controller.config.provider_routing = Some(provider_routing_policy());
    controller.queue.swept.store(true, Ordering::Release);
    controller.drain_locked(BROWSER).await;
    let after = f
        .store
        .conversation_settings(BROWSER, &f.owner, &conversation)
        .await
        .unwrap();
    assert_eq!(after.provider, ConversationProvider::Codex);
}

#[tokio::test]
async fn provider_routing_cannot_switch_an_existing_window_or_consume_its_followup() {
    use orkestr_v2_contracts::ConversationProvider;
    let f = fixture().await;
    let conversation = f.conversation("policy-existing").await;
    let live = f.occupy(&conversation, "policy-existing").await;
    let mut request = f.request(&conversation, "policy-followup").await;
    request.window_id = Some(live.window_id);
    request.expected_generation = live.generation;
    let mut policy = provider_routing_policy();
    policy.rules[0].excluded = ConversationProvider::Codex;
    policy.rules[0].preferred = ConversationProvider::Claude;
    let mut controller = f.controller(8);
    controller.config.provider_routing = Some(policy);
    controller.config.claude = Some(crate::beta_config::ClaudeWindow {
        launcher: "/opt/synthetic/claude-launcher".into(),
        launcher_sha256: "b".repeat(64),
        workspace: "/srv/synthetic/claude-workspace".into(),
        default: false,
        fast: false,
    });
    assert!(matches!(
        controller
            .process(BROWSER, &f.owner, &conversation, &request)
            .await,
        Err("provider routing requires an explicit provider handoff")
    ));
    let settings = f
        .store
        .conversation_settings(BROWSER, &f.owner, &conversation)
        .await
        .unwrap();
    assert_eq!(settings.provider, ConversationProvider::Codex);
    assert_eq!(settings.revision, 0);
    assert_eq!(f.windows(&conversation).await, 1);
}
