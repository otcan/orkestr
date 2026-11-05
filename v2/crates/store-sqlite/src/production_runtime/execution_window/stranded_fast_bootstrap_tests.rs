//! A retained failed reservation cannot permanently strand a first opening.
use super::*;

async fn retained_runs(store: &Store) -> String {
    sqlx::query_scalar("SELECT json_group_array(json_array(id,state,dispatch_state,event_id,native_session_id,lease_generation,dispatch_fence,lease_deadline_ms,binding_generation)) FROM production_runs")
        .fetch_one(&store.pool).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_first_fast_rebootstraps_fresh_bindings_without_replaying_retained_run() {
    let w = Window::open().await;
    let (fresh, _) = retirement::settle(&w, false, true).await;
    let before = retained_runs(&fresh).await;
    assert!(fresh
        .execution_window_failed_first_open_authenticated(&w.browser_credential, &w.f.conversation)
        .await
        .unwrap());
    let boot = fresh
        .rebootstrap_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    assert_ne!(boot.binding().session_id, w.roles.deep.session_id);
    assert_eq!(boot.binding().state, SessionState::Starting);
    assert_eq!(boot.binding().provider_kind, ProviderKind::Unconfigured);
    assert!(boot.binding().native_session_id.is_none());
    assert_eq!(retained_runs(&fresh).await, before);
    let mut next = input(&w.f, "new-first-fast-rebootstrap-input").await;
    next.expected_generation = 1;
    next.predecessor_window_id = Some(w.status.window_id);
    let admitted = fresh
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &next)
        .await
        .unwrap();
    assert_eq!(admitted.status.generation, 2);
    let grant = boot
        .store()
        .issue_execution_window_credential(
            boot.credential(),
            admitted.status.window_id,
            2,
            "new-first-fast-boot",
            admitted.status.expires_at_ms,
            &"c".repeat(64),
        )
        .await
        .unwrap();
    boot.store()
        .bind_execution_window(boot.credential(), &grant)
        .await
        .unwrap();
    assert_eq!(retained_runs(&fresh).await, before);
    assert!(
        fresh
            .rebootstrap_execution_window_authenticated(
                &w.browser_credential,
                &w.f.conversation,
                fixtures::config(ProductionTakeover::First),
            )
            .await
            .is_err(),
        "an active successor cannot obtain another bootstrap"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_first_fast_rebootstrap_refuses_unclosed_or_consumed_turns_without_writes() {
    for consumed in [false, true] {
        let w = Window::open().await;
        let (fresh, _) = retirement::settle(&w, consumed, false).await;
        let before = fixtures::snapshot(&fresh).await;
        assert!(fresh
            .rebootstrap_execution_window_authenticated(
                &w.browser_credential,
                &w.f.conversation,
                fixtures::config(ProductionTakeover::First),
            )
            .await
            .is_err());
        assert_eq!(fixtures::snapshot(&fresh).await, before);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_first_fast_rebootstrap_requires_original_lapse_fence_and_current_owner() {
    let w = Window::open().await;
    let (fresh, run) = retirement::settle(&w, false, true).await;
    let before = fixtures::snapshot(&fresh).await;
    assert!(fresh
        .rebootstrap_execution_window_authenticated(
            "revoked",
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .is_err());
    assert_eq!(fixtures::snapshot(&fresh).await, before);
    sqlx::query("UPDATE production_runs SET dispatch_fence=dispatch_fence+1 WHERE id=?")
        .bind(run.to_string())
        .execute(&fresh.pool)
        .await
        .unwrap();
    let before = fixtures::snapshot(&fresh).await;
    assert!(fresh
        .rebootstrap_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .is_err());
    assert_eq!(fixtures::snapshot(&fresh).await, before);
}
