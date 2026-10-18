use orkestr_v2_store_sqlite::{
    history_import::{
        timers::{input::TimerInputRequest, *},
        HistoryError,
    },
    Store,
};
use sqlx::{Connection, Row};
use std::path::Path;
use uuid::Uuid;
async fn snapshot(path: &Path) -> Vec<String> {
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(path)
            .read_only(true),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA query_only=ON")
        .execute(&mut db)
        .await
        .unwrap();
    let mut tx = db.begin().await.unwrap();
    let mut out = vec![];
    for table in [
        "dormant_timers",
        "dormant_timer_controls",
        "dormant_timer_claims",
        "dormant_timer_input_guards",
        "dormant_timer_inputs",
        "conversations",
        "messages",
        "events",
        "reasoning_inbox",
        "outbox",
        "production_runs",
        "production_observations",
    ] {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap()
            .iter()
            .map(|r| format!("\"{}\"", r.get::<String, _>("name")))
            .collect::<Vec<_>>()
            .join(",");
        out.push(table.into());
        out.extend(
            sqlx::query_scalar::<_, String>(&format!(
                "SELECT json_array({columns}) FROM {table} ORDER BY rowid"
            ))
            .fetch_all(&mut *tx)
            .await
            .unwrap(),
        );
    }
    tx.commit().await.unwrap();
    db.close().await.unwrap();
    out
}
#[tokio::test]
async fn reopen_conflict_foreign_owner_controls_and_revocation_preserve_all_rows() {
    for action in [
        TimerControl::Disable,
        TimerControl::Stop,
        TimerControl::Rollback,
    ] {
        let root =
            std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("owned home"))
                .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("core.sqlite3");
        let store = Store::open(&path).await.unwrap();
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
        let token = "ab".repeat(32);
        store.save_session(&token, &owner).await.unwrap();
        let source = TimerImportRequest {
            namespace: Uuid::new_v4(),
            source_namespace: "synthetic-source".into(),
            source_timer_id: "synthetic-timer".into(),
            source_enabled: true,
            schedule: TimerSchedule::Interval { every_ms: 60000 },
        };
        store
            .import_dormant_timer(&token, &owner, &source)
            .await
            .unwrap();
        let enabled = store
            .enable_timer_input(
                &token,
                &owner,
                &TimerEnableRequest {
                    namespace: source.namespace,
                    expected_revision: 1,
                    request_key: "enable".into(),
                    conversation_id: conversation.clone(),
                },
                1767225600000,
            )
            .await
            .unwrap();
        let mut request = TimerInputRequest {
            claim: TimerClaimRequest {
                namespace: source.namespace,
                generation: enabled.generation,
                request_key: "occurrence".into(),
                due_ms: enabled.next_due_ms.unwrap(),
            },
            text: "synthetic new owner work".into(),
        };
        let receipt = store
            .admit_timer_input(&token, &owner, &request, request.claim.due_ms)
            .await
            .unwrap();
        assert!(!receipt.duplicate);
        store.close().await;
        let store = Store::open(&path).await.unwrap();
        let before = snapshot(&path).await;
        let replay = store
            .admit_timer_input(&token, &owner, &request, request.claim.due_ms)
            .await
            .unwrap();
        assert!(replay.duplicate);
        assert_eq!(
            serde_json::to_value(&receipt.input).unwrap(),
            serde_json::to_value(&replay.input).unwrap()
        );
        assert_eq!(snapshot(&path).await, before);
        request.text.push('!');
        assert!(matches!(
            store
                .admit_timer_input(&token, &owner, &request, request.claim.due_ms)
                .await,
            Err(HistoryError::Conflict)
        ));
        assert_eq!(snapshot(&path).await, before);
        request.text.pop();
        let foreign = orkestr_v2_contracts::OwnerId(Uuid::new_v4());
        assert!(matches!(
            store
                .admit_timer_input(&token, &foreign, &request, request.claim.due_ms)
                .await,
            Err(HistoryError::Unauthorized)
        ));
        assert_eq!(snapshot(&path).await, before);
        store
            .control_dormant_timer(
                &token,
                &owner,
                &TimerControlRequest {
                    namespace: source.namespace,
                    expected_revision: enabled.revision,
                    request_key: "control".into(),
                    action,
                },
            )
            .await
            .unwrap();
        store.close().await;
        let store = Store::open(&path).await.unwrap();
        let before = snapshot(&path).await;
        assert!(matches!(
            store
                .admit_timer_input(&token, &owner, &request, request.claim.due_ms)
                .await,
            Err(HistoryError::Conflict)
        ));
        assert_eq!(snapshot(&path).await, before);
        store.revoke_session(&token).await.unwrap();
        assert!(matches!(
            store
                .admit_timer_input(&token, &owner, &request, request.claim.due_ms)
                .await,
            Err(HistoryError::Unauthorized)
        ));
        assert_eq!(snapshot(&path).await, before);
        store.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}
