use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;
use std::path::PathBuf;

async fn fixture() -> (Store, PathBuf, OwnerId, ConversationId) {
    let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated test home"))
        .join(format!("runtime-store-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let store = Store::open(&root.join("test.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let (owner, _) = store.credentials("synthetic-owner").await.unwrap().unwrap();
    (store, root, owner, conversation)
}

#[tokio::test]
async fn bindings_are_distinct_idempotent_and_durable() {
    let (store, root, owner, conversation) = fixture().await;
    let (a, b) = tokio::join!(
        store.ensure_role_bindings(&owner, &conversation),
        store.ensure_role_bindings(&owner, &conversation)
    );
    let roles = a.unwrap();
    assert_eq!(roles, b.unwrap());
    assert_ne!(roles.fast.session_id, roles.deep.session_id);
    assert!(roles.fast.native_session_id.is_none());
    assert_eq!(roles.deep.state, SessionState::Starting);
    let worker = store
        .create_worker_binding(
            &owner,
            &conversation,
            Some(&roles.deep.session_id),
            "worker:1",
        )
        .await
        .unwrap();
    assert_ne!(worker.session_id, roles.deep.session_id);
    assert_eq!(
        worker,
        store
            .create_worker_binding(
                &owner,
                &conversation,
                Some(&roles.deep.session_id),
                "worker:1"
            )
            .await
            .unwrap()
    );
    assert_eq!(
        store
            .create_worker_binding(&owner, &conversation, None, "worker:1")
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    store.close().await;
    let reopened = Store::open(&root.join("test.sqlite3")).await.unwrap();
    assert_eq!(
        roles,
        reopened
            .ensure_role_bindings(&owner, &conversation)
            .await
            .unwrap()
    );
    reopened.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn claim_race_expiry_and_followup_order() {
    let (store, root, owner, conversation) = fixture().await;
    let roles = store
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap();
    for n in 1..=2 {
        store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: format!("message:{n}"),
                    text: "synthetic input".into(),
                },
            )
            .await
            .unwrap();
    }
    let lease = Duration::from_secs(10);
    let (a, b) = tokio::join!(
        store.claim_next(&owner, &conversation, &roles.deep.session_id, lease),
        store.claim_next(&owner, &conversation, &roles.deep.session_id, lease)
    );
    let claim = match (a, b) {
        (Ok(Some(claim)), Err(RuntimeStoreError::Busy))
        | (Err(RuntimeStoreError::Busy), Ok(Some(claim))) => claim,
        other => panic!("unexpected competing claims: {other:?}"),
    };
    assert_eq!(claim.scope_sequence, 1);
    assert_eq!(claim.claim_generation, 1);
    // Deterministic expiry through owned test DB, no timing-dependent sleep.
    sqlx::query("UPDATE reasoning_inbox SET claim_deadline_ms=0 WHERE sequence=1")
        .execute(&store.pool)
        .await
        .unwrap();
    let reclaimed = store
        .claim_next(&owner, &conversation, &roles.deep.session_id, lease)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reclaimed.message_id, claim.message_id);
    assert_eq!(reclaimed.claim_generation, 2);
    let queued: i64 =
        sqlx::query_scalar("SELECT count(*) FROM reasoning_inbox WHERE state='queued'")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(queued, 1);
    assert_eq!(
        store
            .admit_run(&reclaimed, &roles.deep.session_id, 1, "run:1")
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn scope_and_role_checks_precede_claim_mutation() {
    let (store, root, owner, conversation) = fixture().await;
    let roles = store
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap();
    let stranger = OwnerId(Uuid::new_v4());
    assert_eq!(
        store
            .ensure_role_bindings(&stranger, &conversation)
            .await
            .unwrap_err(),
        RuntimeStoreError::NotFound
    );
    assert_eq!(
        store
            .claim_next(
                &owner,
                &conversation,
                &roles.fast.session_id,
                Duration::from_secs(1)
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::NotFound
    );
    assert_eq!(
        store
            .claim_next(
                &owner,
                &conversation,
                &roles.deep.session_id,
                Duration::from_millis(999)
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::InvalidInput
    );
    let other = store
        .create_project(
            &owner,
            &orkestr_v2_contracts::ProjectInput {
                client_request_id: "other:1".into(),
                name: "Synthetic project".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .create_worker_binding(
                &owner,
                &other.project.conversation_id,
                Some(&roles.deep.session_id),
                "worker:cross"
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::NotFound
    );
    store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
