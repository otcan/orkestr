//! Core registration oracle: two pools, current auth and inert replay after reopen.
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::{history_source_digest, HistoryError, Store};
use sqlx::{Connection, SqliteConnection};
use uuid::Uuid;

#[tokio::test]
async fn concurrent_import_reopen_and_logout_preserve_inert_ledger() {
    let directory = std::env::temp_dir().join(format!("history-core-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("core.sqlite3");
    let first = Store::open(&path).await.unwrap();
    first
        .setup("synthetic", "synthetic-password-hash")
        .await
        .unwrap();
    let owner = first.credentials("synthetic").await.unwrap().unwrap().0;
    let token = "synthetic-history-session";
    first.save_session(token, &owner).await.unwrap();
    let mut request = HistoryImportRequest {
        namespace: Uuid::new_v4(),
        source_digest: String::new(),
        source_conversation_id: ConversationId(Uuid::new_v4()),
        source_scope: Scope::Global,
        source_watermark: 7,
        messages: vec![Message {
            message_id: MessageId(Uuid::new_v4()),
            sequence: 7,
            actor_kind: "owner".into(),
            text: "Synthetic é history".into(),
            reply_to: None,
            origin: None,
        }],
    };
    request.source_digest = history_source_digest(&request).unwrap();
    let second = Store::open(&path).await.unwrap();
    let (a, b) = tokio::join!(
        first.import_history(token, &owner, &request),
        second.import_history(token, &owner, &request)
    );
    let imported = a.unwrap();
    assert_eq!(imported, b.unwrap());
    first.close().await;
    second.close().await;
    let reopened = Store::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .import_history(token, &owner, &request)
            .await
            .unwrap(),
        imported
    );
    let rollback = HistoryRollbackRequest {
        namespace: request.namespace,
        expected_revision: 1,
    };
    let rolled = reopened
        .rollback_history(token, &owner, &rollback)
        .await
        .unwrap();
    assert_eq!((rolled.revision, rolled.active), (2, false));
    assert_eq!(
        reopened
            .import_history(token, &owner, &request)
            .await
            .unwrap(),
        imported
    );
    assert!(reopened
        .history_messages(token, &owner, request.namespace, None, 100)
        .await
        .unwrap()
        .is_empty());
    reopened.revoke_session(token).await.unwrap();
    assert_eq!(
        reopened.import_history(token, &owner, &request).await,
        Err(HistoryError::Unauthorized)
    );
    assert_eq!(
        reopened.rollback_history(token, &owner, &rollback).await,
        Err(HistoryError::Unauthorized)
    );
    assert_eq!(
        reopened
            .history_receipt(token, &owner, request.namespace)
            .await,
        Err(HistoryError::Unauthorized)
    );
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .read_only(true);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    for table in [
        "messages",
        "events",
        "outbox",
        "reasoning_inbox",
        "production_runs",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(count, 0, "history activated {table}");
    }
    let state: (i64, i64, i64) = sqlx::query_as(
        "SELECT revision,active,(SELECT count(*) FROM history_messages) FROM history_imports",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(state, (2, 0, 1));
    connection.close().await.unwrap();
    reopened.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}
