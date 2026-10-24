use super::*;

#[tokio::test]
async fn provider_handoff_missing_current_schema_never_uses_legacy_fixture_compatibility() {
    let p = pending().await;
    let mut tx = p.w.f.store.pool.begin().await.unwrap();
    for table in [
        "conversation_handoff_context_delivery",
        "conversation_handoff_sessions",
        "conversation_provider_handoffs",
    ] {
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    assert!(matches!(
        crate::production_runtime::execution_window::handoff_context::attach(
            &mut tx,
            &p.deep,
            "synthetic new input".into()
        )
        .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn legacy_denied_model_cannot_launch_but_can_handoff_without_changing_reply_policy() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    retire_old(&fresh, w).await;
    super::super::native_reset_tests::select_claude(&fresh, w).await;
    // Model legacy stored state; this is never a provider call or launch.
    sqlx::query("UPDATE conversation_settings SET model='fable',honor_no_reply=0,reply_prefix='kept:',reply_footer='kept footer',review_before_accepting=1")
        .execute(&fresh.pool).await.unwrap();
    assert!(fresh
        .conversation_turn_launch(&w.f.owner, &w.f.conversation)
        .await
        .is_err());
    let mut req = request(w);
    req.expected_settings_revision = 1;
    req.target_provider = ConversationProvider::Codex;
    req.model = Some("gpt-6.1-sol".into());
    fresh
        .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &req)
        .await
        .unwrap();
    let settings = fresh
        .conversation_settings(&w.browser_credential, &w.f.owner, &w.f.conversation)
        .await
        .unwrap();
    assert_eq!(settings.provider, ConversationProvider::Codex);
    assert!(!settings.honor_no_reply);
    assert_eq!(settings.reply_prefix.as_deref(), Some("kept:"));
    assert_eq!(settings.reply_footer.as_deref(), Some("kept footer"));
    assert!(settings.review_before_accepting);
    assert!(fresh
        .conversation_turn_launch(&w.f.owner, &w.f.conversation)
        .await
        .is_ok());
}

#[tokio::test]
async fn uncertain_binding_state_refuses_without_retiring_it_or_changing_settings() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    retire_old(&fresh, w).await;
    for state in ["busy", "blocked", "lost"] {
        sqlx::query("UPDATE session_bindings SET state=? WHERE id=?")
            .bind(state)
            .bind(p.deep.binding.session_id.to_string())
            .execute(&fresh.pool)
            .await
            .unwrap();
        assert!(fresh
            .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &request(w))
            .await
            .is_err());
        assert_eq!(
            count(
                &fresh,
                "SELECT count(*) FROM conversation_provider_handoffs"
            )
            .await,
            0
        );
        assert_eq!(
            count(&fresh, "SELECT count(*) FROM conversation_settings").await,
            0
        );
    }
}
