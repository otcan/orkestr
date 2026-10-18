//! Registration-free caller tests; no default Fast activation.
#[path = "../src/fast_execution/mod.rs"]
mod fast_execution;
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::{EventId, MessageId};
use orkestr_v2_store_sqlite::{FastAdmissionInput, Store};

#[tokio::test]
async fn canonical_unavailable_fast_issuer_never_falls_back_to_deep() {
    let root = std::path::PathBuf::from(std::env::var("ORKESTR_V2_HOME").unwrap())
        .join(format!("fast-caller-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let store = Store::open(&root.join("state.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "de".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let bound = store
        .authorize_supervisor(
            &token,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "subscription:synthetic".into(),
                supervisor_key: "synthetic-fast".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let bindings = bound
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap();
    let input = FastAdmissionInput {
        source_message_id: MessageId(uuid::Uuid::new_v4()),
        source_event_id: EventId(uuid::Uuid::new_v4()),
        fast_binding_id: bindings.fast.session_id.clone(),
        expected_binding_generation: bindings.fast.generation,
        request_key: "fast-presentation:1".into(),
    };
    assert!(matches!(
        fast_execution::consume_fast(&bound, &token, &input).await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert!(matches!(
        fast_execution::consume_fast(&bound, &"00".repeat(32), &input).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(
        bindings,
        bound
            .ensure_role_bindings(&owner, &conversation)
            .await
            .unwrap()
    );
    assert!(store
        .execution_status(&owner, &conversation)
        .await
        .unwrap()
        .is_none());
    // This remains a real owned capability type, never a caller-issued admission.
    fn capability_shape(result: fast_execution::FastDispatch) {
        if let fast_execution::FastDispatch::Consumed(cap) = result {
            drop(cap);
        }
    }
    capability_shape(fast_execution::FastDispatch::Replay);
    drop(bound);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
