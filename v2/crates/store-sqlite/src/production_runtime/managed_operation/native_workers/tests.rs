use super::*;
use crate::production_runtime::observation_tests::input;

fn request(operation: &str, arguments: Value) -> ManagedOperationRequest {
    ManagedOperationRequest {
        version: 1,
        request_key: "mcp:synthetic-rpc".into(),
        operation: operation.into(),
        arguments,
    }
}
fn submit() -> ManagedOperationRequest {
    request(
        "worker_submit",
        json!({"title":"Bounded synthetic subtask","instructions":"Count only these synthetic values: 1, 2, 3."}),
    )
}
fn available() -> NativeWorkerAvailability {
    NativeWorkerAvailability {
        configured: true,
        scheduler_available: true,
        execution_budget_ms: None,
    }
}
async fn running() -> (
    crate::production_runtime::tests::Case,
    Store,
    String,
    ManagedOperationParent,
    ManagedCallerEvidence,
) {
    let (f, store, token, parent, source) = super::super::tests::fixture().await;
    store
        .append_provider_event(
            &f.owner,
            &parent.parent,
            &input(&parent.parent, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    (f, store, token, parent, source)
}
async fn capability(
    store: &Store,
    token: &str,
    parent: &ManagedOperationParent,
    source: &ManagedCallerEvidence,
    availability: NativeWorkerAvailability,
) -> Value {
    let call = store
        .begin_native_worker_call(
            token,
            parent,
            Uuid::new_v4(),
            source,
            &request("worker_capability", json!({})),
            availability,
        )
        .await
        .unwrap();
    store
        .observe_native_worker_call(token, parent, &call)
        .await
        .unwrap()
        .result
}

#[tokio::test]
async fn native_create_replay_is_atomic_and_never_uses_browser_credentials() {
    let (f, store, token, parent, source) = running().await;
    let id = Uuid::new_v4();
    let request = submit();
    let (a, b) = tokio::join!(
        store.begin_native_worker_call(&token, &parent, id, &source, &request, available()),
        store.begin_native_worker_call(&token, &parent, id, &source, &request, available())
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.task, b.task);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tasks")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(rows, 1);
    let authority_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM managed_operations")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(authority_rows, 0); // No fake Root operation or schema-tag reuse.
    let observation = store
        .observe_native_worker_call(&token, &parent, &a)
        .await
        .unwrap();
    assert_eq!(observation.result["phase"], "queued");
    assert!(observation.result["run_id"].is_null());
    assert!(observation.result["provider"].is_null());
    assert!(observation.result["result"].is_null());
    assert!(!observation.terminal());
    let mut changed = submit();
    changed.arguments["instructions"] = json!("A different task");
    assert!(matches!(
        store
            .begin_native_worker_call(&token, &parent, id, &source, &changed, available())
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    // Reattaching a current Core handle preserves the durable association.
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = store.reattach_supervisor(&reopened).await.unwrap();
    let replay = attached
        .begin_native_worker_call(&token, &parent, id, &source, &request, available())
        .await
        .unwrap();
    assert_eq!(replay.task, a.task);
    // The owner browser bearer is not a Native operation credential.
    let browser = format!("browser:{}", "ab".repeat(32));
    f.store.save_session(&browser, &f.owner).await.unwrap();
    assert!(store
        .begin_native_worker_call(
            &browser,
            &parent,
            Uuid::new_v4(),
            &source,
            &request,
            available()
        )
        .await
        .is_err());
}

#[tokio::test]
async fn all_five_capability_states_reflect_actual_composition_and_current_scope() {
    let (_f, store, token, mut parent, mut source) = running().await;
    assert_eq!(
        capability(&store, &token, &parent, &source, available()).await["state"],
        "ready"
    );
    assert_eq!(
        capability(
            &store,
            &token,
            &parent,
            &source,
            NativeWorkerAvailability {
                configured: false,
                scheduler_available: false,
                execution_budget_ms: None,
            }
        )
        .await["state"],
        "setup_required"
    );
    assert_eq!(
        capability(
            &store,
            &token,
            &parent,
            &source,
            NativeWorkerAvailability {
                configured: true,
                scheduler_available: false,
                execution_budget_ms: None,
            }
        )
        .await["state"],
        "unhealthy"
    );
    let refused = store
        .begin_native_worker_call(
            &token,
            &parent,
            Uuid::new_v4(),
            &source,
            &submit(),
            NativeWorkerAvailability {
                configured: true,
                scheduler_available: false,
                execution_budget_ms: None,
            },
        )
        .await
        .unwrap();
    assert!(refused.task.is_none());
    for n in 0..32 {
        let mut request = submit();
        request.request_key = format!("mcp:{n}");
        store
            .begin_native_worker_call(
                &token,
                &parent,
                Uuid::new_v4(),
                &source,
                &request,
                available(),
            )
            .await
            .unwrap();
    }
    assert_eq!(
        capability(&store, &token, &parent, &source, available()).await["state"],
        "denied"
    );
    let refused = store
        .begin_native_worker_call(
            &token,
            &parent,
            Uuid::new_v4(),
            &source,
            &submit(),
            available(),
        )
        .await
        .unwrap();
    assert!(refused.task.is_none());
    // A provider cannot select a fallback scheduler. This synthetic fixture
    // switches both current setup evidence fields only to test presentation.
    parent.setup.provider = ProviderKind::Claude;
    source.provider = "claude".into();
    assert_eq!(
        capability(&store, &token, &parent, &source, available()).await["state"],
        "not_supported"
    );
}

#[tokio::test]
async fn injected_authority_foreign_tasks_and_revoked_native_context_are_refused() {
    let (f, store, token, parent, source) = running().await;
    for field in [
        "owner_id",
        "parent_run_id",
        "conversation_id",
        "session_id",
        "provider",
        "workspace",
        "execution_budget_ms",
    ] {
        let mut req = submit();
        req.arguments[field] = json!("untrusted");
        assert!(store
            .begin_native_worker_call(&token, &parent, Uuid::new_v4(), &source, &req, available())
            .await
            .is_err());
    }
    for field in [
        "run_id",
        "owner_id",
        "conversation_id",
        "session_id",
        "incarnation",
        "provider",
    ] {
        let mut source = serde_json::to_value(&source).unwrap();
        source[field] = json!(Uuid::new_v4().to_string());
        let source: ManagedCallerEvidence = serde_json::from_value(source).unwrap();
        assert!(store
            .begin_native_worker_call(
                &token,
                &parent,
                Uuid::new_v4(),
                &source,
                &submit(),
                available()
            )
            .await
            .is_err());
    }
    let foreign = request("worker_status", json!({"task_id":Uuid::new_v4()}));
    assert!(matches!(
        store
            .begin_native_worker_call(
                &token,
                &parent,
                Uuid::new_v4(),
                &source,
                &foreign,
                available()
            )
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    let id = Uuid::new_v4();
    let call = store
        .begin_native_worker_call(&token, &parent, id, &source, &submit(), available())
        .await
        .unwrap();
    f.store.revoke_session(&token).await.unwrap();
    assert!(store
        .observe_native_worker_call(&token, &parent, &call)
        .await
        .is_err());
    assert!(store
        .begin_native_worker_call(&token, &parent, id, &source, &submit(), available())
        .await
        .is_err());
}

#[path = "result_tests.rs"]
mod results;

#[tokio::test]
async fn only_the_trusted_sealed_selection_supplies_a_task_budget() {
    let (_f, store, token, parent, source) = running().await;
    let selected = NativeWorkerAvailability {
        execution_budget_ms: Some(300_000),
        ..available()
    };
    let call = store
        .begin_native_worker_call(
            &token,
            &parent,
            Uuid::new_v4(),
            &source,
            &submit(),
            selected,
        )
        .await
        .unwrap();
    assert!(call.waits());
    let claim = store
        .claim_worker_task(&token, &parent.parent.run.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.execution_budget_ms(), Some(300_000));
    for bad in [0, 29_999, 3_600_001] {
        let selected = NativeWorkerAvailability {
            execution_budget_ms: Some(bad),
            ..available()
        };
        assert!(matches!(
            store
                .begin_native_worker_call(
                    &token,
                    &parent,
                    Uuid::new_v4(),
                    &source,
                    &submit(),
                    selected
                )
                .await,
            Err(RuntimeStoreError::InvalidInput)
        ));
    }
}

#[test]
fn reply_expiry_is_bounded_by_delivery_window_and_immutable_parent_lease() {
    assert_eq!(delivery_expiry(61_000, 1_000).unwrap(), 26_000);
    assert_eq!(delivery_expiry(11_000, 1_000).unwrap(), 11_000);
    assert!(delivery_expiry(1_000, 1_000).is_err());
    assert!(delivery_expiry(999, 1_000).is_err());
    assert!(delivery_expiry(i64::MAX, i64::MAX - 100).is_err());
}
