use super::*;

fn request() -> HistoryImportRequest {
    let mut request = HistoryImportRequest {
        namespace: Uuid::from_u128(1),
        source_digest: String::new(),
        source_conversation_id: ConversationId(Uuid::from_u128(2)),
        source_scope: Scope::Global,
        source_watermark: 3,
        messages: vec![Message {
            message_id: MessageId(Uuid::from_u128(3)),
            sequence: 3,
            actor_kind: "owner".into(),
            text: "Synthetic history é".into(),
            reply_to: None,
            origin: None,
        }],
    };
    request.source_digest = history_source_digest(&request).unwrap();
    request
}
async fn fixture() -> (Store, OwnerId, std::path::PathBuf) {
    let directory = std::env::temp_dir().join(format!("history-test-{}", Uuid::new_v4()));
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
async fn cleanup(store: Store, directory: std::path::PathBuf) {
    store.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn pinned_empty_binary_vector() {
    let mut value = request();
    value.messages.clear();
    value.source_watermark = 0;
    assert_eq!(
        history_source_digest(&value).unwrap(),
        "705fbd75e107ac9ebf0f4f5d1adb1ac05629d3b30b8abd8d674626f4aafc40e3"
    );
}
#[test]
fn validation_refuses_invalid_source() {
    let original = request();
    for variant in 0..8 {
        let mut value = original.clone();
        match variant {
            0 => value.namespace = Uuid::nil(),
            1 => value.source_conversation_id = ConversationId(Uuid::nil()),
            2 => {
                value.source_scope = Scope::Project {
                    project_id: ProjectId(Uuid::nil()),
                }
            }
            3 => value.messages[0].message_id = MessageId(Uuid::nil()),
            4 => value.messages[0].actor_kind = "provider".into(),
            5 => value.source_watermark = 2,
            6 => value.messages.push(value.messages[0].clone()),
            _ => value.messages[0].text = "a".repeat(1024 * 1024 + 1),
        }
        assert_eq!(history_source_digest(&value), Err(HistoryError::Invalid));
    }
}
#[tokio::test]
async fn replay_rollback_and_inactive_readback() {
    let (store, owner, directory) = fixture().await;
    let input = request();
    let imported = store
        .import_history("synthetic-token", &owner, &input)
        .await
        .unwrap();
    assert!(imported.active);
    assert_eq!(
        store
            .import_history("synthetic-token", &owner, &input)
            .await
            .unwrap(),
        imported
    );
    assert_eq!(
        store
            .history_messages("synthetic-token", &owner, input.namespace, None, 1)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .history_messages("synthetic-token", &owner, input.namespace, Some(3), 1)
        .await
        .unwrap()
        .is_empty());
    let rollback = HistoryRollbackRequest {
        namespace: input.namespace,
        expected_revision: 1,
    };
    let receipt = store
        .rollback_history("synthetic-token", &owner, &rollback)
        .await
        .unwrap();
    assert_eq!(
        store
            .rollback_history("synthetic-token", &owner, &rollback)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        store
            .import_history("synthetic-token", &owner, &input)
            .await
            .unwrap(),
        imported
    );
    let current = store
        .history_receipt("synthetic-token", &owner, input.namespace)
        .await
        .unwrap();
    assert_eq!((current.revision, current.active), (2, false));
    assert!(store
        .history_messages("synthetic-token", &owner, input.namespace, None, 100)
        .await
        .unwrap()
        .is_empty());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM history_messages")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let native: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(native, 0);
    cleanup(store, directory).await;
}
#[tokio::test]
async fn changed_content_and_corruption_refuse_atomically() {
    let (store, owner, directory) = fixture().await;
    let input = request();
    store
        .import_history("synthetic-token", &owner, &input)
        .await
        .unwrap();
    let mut changed = input.clone();
    changed.messages.clear();
    changed.source_digest = history_source_digest(&changed).unwrap();
    assert_eq!(
        store
            .import_history("synthetic-token", &owner, &changed)
            .await,
        Err(HistoryError::Conflict)
    );
    sqlx::query("UPDATE history_messages SET text='changed synthetic text'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        store
            .import_history("synthetic-token", &owner, &input)
            .await,
        Err(HistoryError::Conflict)
    );
    assert_eq!(
        store
            .rollback_history(
                "synthetic-token",
                &owner,
                &HistoryRollbackRequest {
                    namespace: input.namespace,
                    expected_revision: 1
                }
            )
            .await,
        Err(HistoryError::Conflict)
    );
    let active: i64 = sqlx::query_scalar("SELECT active FROM history_imports")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(active, 1);
    cleanup(store, directory).await;
}
#[tokio::test]
async fn current_auth_before_lookup_and_expiry() {
    let (store, owner, directory) = fixture().await;
    let input = request();
    assert_eq!(
        store.import_history("wrong", &owner, &input).await,
        Err(HistoryError::Unauthorized)
    );
    assert_eq!(
        store
            .history_receipt("wrong", &owner, input.namespace)
            .await,
        Err(HistoryError::Unauthorized)
    );
    store
        .import_history("synthetic-token", &owner, &input)
        .await
        .unwrap();
    sqlx::query("UPDATE auth_sessions SET expires_at=0")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        store
            .history_receipt("synthetic-token", &owner, input.namespace)
            .await,
        Err(HistoryError::Unauthorized)
    );
    assert_eq!(
        store
            .import_history("synthetic-token", &owner, &input)
            .await,
        Err(HistoryError::Unauthorized)
    );
    cleanup(store, directory).await;
}
#[tokio::test]
async fn insert_failure_leaves_no_partial_batch() {
    let (store, owner, directory) = fixture().await;
    sqlx::query("CREATE TRIGGER synthetic_failure BEFORE INSERT ON history_messages BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").execute(&store.pool).await.unwrap();
    assert_eq!(
        store
            .import_history("synthetic-token", &owner, &request())
            .await,
        Err(HistoryError::Unavailable)
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM history_imports")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    cleanup(store, directory).await;
}
