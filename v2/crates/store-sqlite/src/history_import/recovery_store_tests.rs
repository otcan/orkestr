//! Actual schema-20 Store integration tests; synthetic content only.
use super::recovery_export::*;
use super::*;

async fn fixture() -> (Store, OwnerId, std::path::PathBuf) {
    let directory = std::env::temp_dir().join(format!("recovery-test-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let store = Store::open(&directory.join("store.sqlite3")).await.unwrap();
    store
        .setup("synthetic-owner", "synthetic-password-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    store.save_session("synthetic-token", &owner).await.unwrap();
    (store, owner, directory)
}
fn request(inactive: bool) -> HistoryRecoveryRestoreRequest {
    let source = |n| {
        let mut request = HistoryImportRequest {
            namespace: Uuid::from_u128(n),
            source_digest: String::new(),
            source_conversation_id: ConversationId(Uuid::from_u128(n + 10)),
            source_scope: Scope::Global,
            source_watermark: 1,
            messages: vec![Message {
                message_id: MessageId(Uuid::from_u128(n + 20)),
                sequence: 1,
                actor_kind: "owner".into(),
                text: "Synthetic retained history é".into(),
                reply_to: None,
                origin: None,
            }],
        };
        request.source_digest = history_source_digest(&request).unwrap();
        request
    };
    let original = source(1);
    let receipt = HistoryImportReceipt {
        schema_version: 1,
        owner_id: OwnerId(Uuid::from_u128(50)),
        namespace: original.namespace,
        source_digest: original.source_digest.clone(),
        source_conversation_id: original.source_conversation_id.clone(),
        source_watermark: 1,
        message_count: 1,
        revision: if inactive { 2 } else { 1 },
        active: !inactive,
    };
    let mut bundle = HistoryRecoveryBundle {
        schema_version: 1,
        original,
        current_receipt: receipt,
        native_delta: source(2),
        bundle_digest: String::new(),
    };
    bundle.bundle_digest = history_recovery_digest(&bundle).unwrap();
    HistoryRecoveryRestoreRequest {
        restore_id: Uuid::from_u128(100),
        bundle,
        original_namespace: Uuid::from_u128(101),
        delta_namespace: Uuid::from_u128(102),
    }
}
fn rollback(input: &HistoryRecoveryRestoreRequest) -> HistoryRecoveryRollbackRequest {
    HistoryRecoveryRollbackRequest {
        restore_id: input.restore_id,
        expected_revision: 1,
        request_key: "synthetic-rollback".into(),
    }
}
async fn cleanup(store: Store, directory: std::path::PathBuf) {
    store.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}
#[tokio::test]
async fn complete_reopen_inactive_replay_and_whole_bundle_rollback() {
    let (store, owner, directory) = fixture().await;
    let input = request(true);
    let initial = store
        .restore_history_recovery("synthetic-token", &owner, &input)
        .await
        .unwrap();
    assert!(!initial.original.active);
    assert!(initial.native_delta.active);
    assert_eq!(initial.original.revision, 2);
    // Inactive recovery content must never leak through ordinary history reads.
    assert!(store
        .history_messages(
            "synthetic-token",
            &owner,
            input.original_namespace,
            None,
            10
        )
        .await
        .unwrap()
        .is_empty());
    for namespace in [input.original_namespace, input.delta_namespace] {
        assert_eq!(
            store
                .rollback_history(
                    "synthetic-token",
                    &owner,
                    &HistoryRollbackRequest {
                        namespace,
                        expected_revision: 1
                    }
                )
                .await,
            Err(HistoryError::Conflict)
        );
    }
    store.close().await;
    let store = Store::open(&directory.join("store.sqlite3")).await.unwrap();
    let rolled = store
        .rollback_history_recovery("synthetic-token", &owner, &rollback(&input))
        .await
        .unwrap();
    assert!(!rolled.active);
    assert_eq!(
        store
            .rollback_history_recovery("synthetic-token", &owner, &rollback(&input))
            .await
            .unwrap(),
        rolled
    );
    let replay = store
        .restore_history_recovery("synthetic-token", &owner, &input)
        .await
        .unwrap();
    assert_eq!(
        super::recovery_codec::encode(&replay),
        super::recovery_codec::encode(&initial)
    );
    for namespace in [input.original_namespace, input.delta_namespace] {
        assert!(
            !store
                .history_receipt("synthetic-token", &owner, namespace)
                .await
                .unwrap()
                .active
        );
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    cleanup(store, directory).await;
}
#[tokio::test]
async fn auth_changed_replay_and_occupied_namespaces_refuse() {
    let (store, owner, directory) = fixture().await;
    let input = request(false);
    assert!(matches!(
        store
            .restore_history_recovery("wrong-token", &owner, &input)
            .await,
        Err(HistoryError::Unauthorized)
    ));
    store
        .restore_history_recovery("synthetic-token", &owner, &input)
        .await
        .unwrap();
    for variant in 0..3 {
        let mut changed = input.clone();
        match variant {
            0 => std::mem::swap(
                &mut changed.original_namespace,
                &mut changed.delta_namespace,
            ),
            1 => changed.restore_id = Uuid::from_u128(200),
            _ => {
                changed.bundle.original.messages[0].text = "Changed synthetic content".into();
                changed.bundle.original.source_digest =
                    history_source_digest(&changed.bundle.original).unwrap();
                changed.bundle.current_receipt.source_digest =
                    changed.bundle.original.source_digest.clone();
                changed.bundle.bundle_digest = history_recovery_digest(&changed.bundle).unwrap();
            }
        }
        assert!(matches!(
            store
                .restore_history_recovery("synthetic-token", &owner, &changed)
                .await,
            Err(HistoryError::Conflict)
        ));
    }
    let mut wrong = rollback(&input);
    wrong.expected_revision = 2;
    assert!(matches!(
        store
            .rollback_history_recovery("synthetic-token", &owner, &wrong)
            .await,
        Err(HistoryError::Conflict)
    ));
    store
        .rollback_history_recovery("synthetic-token", &owner, &rollback(&input))
        .await
        .unwrap();
    wrong = rollback(&input);
    wrong.request_key.push_str("-changed");
    assert!(matches!(
        store
            .rollback_history_recovery("synthetic-token", &owner, &wrong)
            .await,
        Err(HistoryError::Conflict)
    ));
    store.revoke_session("synthetic-token").await.unwrap();
    assert!(matches!(
        store
            .restore_history_recovery("synthetic-token", &owner, &input)
            .await,
        Err(HistoryError::Unauthorized)
    ));
    assert!(matches!(
        store
            .rollback_history_recovery("synthetic-token", &owner, &rollback(&input))
            .await,
        Err(HistoryError::Unauthorized)
    ));
    cleanup(store, directory).await;
}
#[tokio::test]
async fn second_child_failure_leaves_no_partial_history_or_outer_receipt() {
    let (store, owner, directory) = fixture().await;
    let input = request(false);
    sqlx::query(&format!("CREATE TRIGGER refuse_delta BEFORE INSERT ON history_imports WHEN NEW.namespace='{}' BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END", input.delta_namespace))
        .execute(&store.pool).await.unwrap();
    assert!(store
        .restore_history_recovery("synthetic-token", &owner, &input)
        .await
        .is_err());
    for table in [
        "history_imports",
        "history_messages",
        "history_recovery_restores",
        "history_recovery_children",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    cleanup(store, directory).await;
}
#[tokio::test]
async fn child_content_or_activity_tamper_holds_whole_rollback() {
    for content in [false, true] {
        let (store, owner, directory) = fixture().await;
        let input = request(false);
        store
            .restore_history_recovery("synthetic-token", &owner, &input)
            .await
            .unwrap();
        if content {
            sqlx::query("UPDATE history_messages SET text='Synthetic tamper' WHERE namespace=?")
                .bind(input.delta_namespace.to_string())
                .execute(&store.pool)
                .await
                .unwrap();
        } else {
            // Use a committed independent state change, bypassing the public hold only in this test.
            sqlx::query("UPDATE history_imports SET active=0,revision=2,rolled_back_at=unixepoch() WHERE namespace=?")
                .bind(input.delta_namespace.to_string()).execute(&store.pool).await.unwrap();
        }
        assert!(matches!(
            store
                .rollback_history_recovery("synthetic-token", &owner, &rollback(&input))
                .await,
            Err(HistoryError::Conflict)
        ));
        assert!(
            store
                .history_receipt("synthetic-token", &owner, input.original_namespace)
                .await
                .unwrap()
                .active
        );
        let revision: i64 = sqlx::query_scalar("SELECT revision FROM history_recovery_restores")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(revision, 1);
        cleanup(store, directory).await;
    }
}

#[tokio::test]
async fn recovery_export_includes_inactive_text_and_native_delta_without_mutation() {
    use orkestr_v2_application::IntakeStore;
    let (store, owner, directory) = fixture().await;
    let input = request(true);
    store
        .restore_history_recovery("synthetic-token", &owner, &input)
        .await
        .unwrap();
    let conversation: String = sqlx::query_scalar("SELECT id FROM conversations WHERE owner_id=?")
        .bind(owner.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap();
    let conversation = ConversationId(Uuid::parse_str(&conversation).unwrap());
    store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "synthetic-native-delta".into(),
                text: "Synthetic native delta".into(),
            },
        )
        .await
        .unwrap();
    let bundle = store
        .export_history_recovery(
            "synthetic-token",
            &owner,
            input.original_namespace,
            &conversation,
        )
        .await
        .unwrap();
    assert!(!bundle.current_receipt.active);
    assert_eq!(
        bundle.original.messages[0].text,
        input.bundle.original.messages[0].text
    );
    assert_eq!(bundle.native_delta.messages.len(), 1);
    assert_eq!(
        bundle.native_delta.messages[0].text,
        "Synthetic native delta"
    );
    assert_eq!(
        history_recovery_digest(&bundle).unwrap(),
        bundle.bundle_digest
    );
    assert!(matches!(
        store
            .export_history_recovery(
                "wrong-token",
                &owner,
                input.original_namespace,
                &conversation
            )
            .await,
        Err(HistoryError::Unauthorized)
    ));
    assert!(store
        .history_messages(
            "synthetic-token",
            &owner,
            input.original_namespace,
            None,
            10
        )
        .await
        .unwrap()
        .is_empty());
    assert!(
        !store
            .history_receipt("synthetic-token", &owner, input.original_namespace)
            .await
            .unwrap()
            .active
    );
    cleanup(store, directory).await;
}
