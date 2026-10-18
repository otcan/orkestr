//! Independently authored actual-method SIGKILL and new-exec dormant-ledger oracle.
#![cfg(feature = "fixture-test-controls")]
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::{history_source_digest, HistoryError, ProductionCheckpoint, Store};
use serde_json::{json, Value};
use sqlx::{Connection, Row};
use std::{
    collections::BTreeMap,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use uuid::Uuid;
type Rows = BTreeMap<String, Vec<Value>>;
const TOKEN: &str = "synthetic-history-process-session";
fn save(root: &Path, name: &str, value: &Value) {
    std::fs::write(root.join(name), serde_json::to_vec(value).unwrap()).unwrap();
}
fn load(root: &Path, name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(root.join(name)).unwrap()).unwrap()
}
async fn snapshot(root: &Path) -> Rows {
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.join("core.sqlite3"))
            .read_only(true),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA query_only=ON")
        .execute(&mut db)
        .await
        .unwrap();
    let mut tx = db.begin().await.unwrap();
    let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(&mut *tx).await.unwrap();
    let mut rows = Rows::new();
    for table in tables {
        assert!(table
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_'));
        let columns = sqlx::query(&format!("PRAGMA table_info(\"{table}\")"))
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        let fields = columns.iter().map(|r| {
            let name: String = r.get("name");
            assert!(name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'));
            format!("'{name}',CASE WHEN typeof(\"{name}\")='blob' THEN hex(\"{name}\") ELSE \"{name}\" END")
        }).collect::<Vec<_>>().join(",");
        let values: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT json_object({fields}) FROM \"{table}\" ORDER BY rowid"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        rows.insert(
            table,
            values
                .iter()
                .map(|v| serde_json::from_str(v).unwrap())
                .collect(),
        );
    }
    tx.commit().await.unwrap();
    db.close().await.unwrap();
    rows
}
fn inert(before: &Rows, after: &Rows) {
    for (table, rows) in before {
        if table != "history_imports" && table != "history_messages" {
            assert!(
                after.get(table) == Some(rows),
                "non-history table changed: {table}"
            );
        }
    }
    assert_eq!(before.len(), after.len());
}
struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn spawn(root: &Path, mode: &str, operation: &str, after: bool) -> Owned {
    Owned(
        Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "history_child"])
            .env_clear()
            .env("ORKESTR_V2_HOME", root)
            .env("MODE", mode)
            .env("OPERATION", operation)
            .env("AFTER", if after { "1" } else { "0" })
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    )
}
#[tokio::test]
#[ignore = "owned child entry invoked by independent parent"]
async fn history_child() {
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    let rollback = std::env::var("OPERATION").unwrap() == "rollback";
    let after = std::env::var("AFTER").unwrap() == "1";
    if std::env::var("MODE").unwrap() == "writer" {
        let mut store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic", "synthetic-password-hash")
            .await
            .unwrap();
        let owner = store.credentials("synthetic").await.unwrap().unwrap().0;
        store.save_session(TOKEN, &owner).await.unwrap();
        store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: "live-sentinel".into(),
                    text: "Synthetic active intake remains unchanged".into(),
                },
            )
            .await
            .unwrap();
        let mut request = HistoryImportRequest {
            namespace: Uuid::new_v4(),
            source_digest: String::new(),
            source_conversation_id: ConversationId(Uuid::new_v4()),
            source_scope: Scope::Global,
            source_watermark: 9,
            messages: vec![
                Message {
                    message_id: MessageId(Uuid::new_v4()),
                    sequence: 2,
                    actor_kind: "owner".into(),
                    text: "Synthetic first é".into(),
                },
                Message {
                    message_id: MessageId(Uuid::new_v4()),
                    sequence: 9,
                    actor_kind: "owner".into(),
                    text: "Synthetic second".into(),
                },
            ],
        };
        request.source_digest = history_source_digest(&request).unwrap();
        if rollback {
            store.import_history(TOKEN, &owner, &request).await.unwrap();
        }
        save(&root, "request", &json!(request));
        save(&root, "owner", &json!(owner));
        save(&root, "before", &json!(snapshot(&root).await));
        let stage = match (rollback, after) {
            (false, false) => ProductionCheckpoint::HistoryImportBeforeCommit,
            (false, true) => ProductionCheckpoint::HistoryImportAfterCommit,
            (true, false) => ProductionCheckpoint::HistoryRollbackBeforeCommit,
            (true, true) => ProductionCheckpoint::HistoryRollbackAfterCommit,
        };
        store
            .production_arm_history_checkpoint(TOKEN, &owner, stage, root.join("marker"))
            .await
            .unwrap();
        if rollback {
            let _ = store
                .rollback_history(
                    TOKEN,
                    &owner,
                    &HistoryRollbackRequest {
                        namespace: request.namespace,
                        expected_revision: 1,
                    },
                )
                .await;
        } else {
            let _ = store.import_history(TOKEN, &owner, &request).await;
        }
        panic!("writer returned before owned SIGKILL");
    }
    let killed: Rows = serde_json::from_value(load(&root, "killed")).unwrap();
    assert!(snapshot(&root).await == killed, "new-exec pre-open differs");
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    assert!(snapshot(&root).await == killed, "open changed rows");
    let owner: OwnerId = serde_json::from_value(load(&root, "owner")).unwrap();
    let request: HistoryImportRequest = serde_json::from_value(load(&root, "request")).unwrap();
    let before: Rows = serde_json::from_value(load(&root, "before")).unwrap();
    if rollback {
        let receipt = store
            .rollback_history(
                TOKEN,
                &owner,
                &HistoryRollbackRequest {
                    namespace: request.namespace,
                    expected_revision: 1,
                },
            )
            .await
            .unwrap();
        assert_eq!((receipt.revision, receipt.active), (2, false));
        let original = store.import_history(TOKEN, &owner, &request).await.unwrap();
        assert_eq!((original.revision, original.active), (1, true));
        assert!(store
            .history_messages(TOKEN, &owner, request.namespace, None, 100)
            .await
            .unwrap()
            .is_empty());
        assert!(
            !store
                .history_receipt(TOKEN, &owner, request.namespace)
                .await
                .unwrap()
                .active
        );
    } else {
        let receipt = store.import_history(TOKEN, &owner, &request).await.unwrap();
        assert_eq!(receipt.source_digest, request.source_digest);
        assert_eq!(receipt.source_watermark, 9);
        assert_eq!(receipt.owner_id, owner);
        assert_eq!(receipt.namespace, request.namespace);
        assert_eq!(
            receipt.source_conversation_id,
            request.source_conversation_id
        );
        assert_eq!(receipt.message_count, 2);
        let messages = store
            .history_messages(TOKEN, &owner, request.namespace, None, 100)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(messages).unwrap(),
            serde_json::to_value(&request.messages).unwrap()
        );
    }
    let committed = snapshot(&root).await;
    inert(&before, &committed);
    if after {
        assert!(committed == killed, "lost receipt retry changed rows");
    }
    let mut changed = request.clone();
    changed.messages[0].text.push('!');
    changed.source_digest = history_source_digest(&changed).unwrap();
    assert_eq!(
        store.import_history(TOKEN, &owner, &changed).await,
        Err(HistoryError::Conflict)
    );
    assert!(snapshot(&root).await == committed);
    store.revoke_session(TOKEN).await.unwrap();
    let revoked = snapshot(&root).await;
    store.close().await;
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    assert!(store.authenticate(TOKEN).await.unwrap().is_none());
    assert_eq!(
        store.import_history(TOKEN, &owner, &request).await,
        Err(HistoryError::Unauthorized)
    );
    assert_eq!(
        store
            .rollback_history(
                TOKEN,
                &owner,
                &HistoryRollbackRequest {
                    namespace: request.namespace,
                    expected_revision: 1
                }
            )
            .await,
        Err(HistoryError::Unauthorized)
    );
    assert!(snapshot(&root).await == revoked);
    save(&root, "done", &json!(true));
}
#[test]
fn history_import_and_rollback_four_sigkill_windows() {
    let base = std::path::PathBuf::from(
        std::env::var_os("ORKESTR_V2_HOME").expect("isolated home required"),
    );
    std::fs::create_dir_all(&base).unwrap();
    for operation in ["import", "rollback"] {
        for after in [false, true] {
            let root = base.join(format!("history-process-{}", Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let mut writer = spawn(&root, "writer", operation, after);
            let marker = format!(
                "history-{operation}-{}-commit",
                if after { "after" } else { "before" }
            );
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Ok(bytes) = std::fs::read(root.join("marker")) {
                    if bytes == marker.as_bytes() {
                        break;
                    }
                }
                assert!(
                    writer.0.try_wait().unwrap().is_none(),
                    "writer exited before marker"
                );
                assert!(Instant::now() < deadline, "checkpoint not reached");
                std::thread::sleep(Duration::from_millis(5));
            }
            writer.0.kill().unwrap();
            let status = writer.0.wait().unwrap();
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(9));
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let before: Rows = serde_json::from_value(load(&root, "before")).unwrap();
            let killed = runtime.block_on(snapshot(&root));
            inert(&before, &killed);
            if !after {
                assert!(before == killed, "precommit partial rows");
            } else if operation == "rollback" {
                let mut expected = before.clone();
                expected.get_mut("history_imports").unwrap()[0]["revision"] = json!(2);
                expected.get_mut("history_imports").unwrap()[0]["active"] = json!(0);
                assert!(killed["history_imports"][0]["rolled_back_at"]
                    .as_i64()
                    .is_some_and(|t| t > 0));
                expected.get_mut("history_imports").unwrap()[0]["rolled_back_at"] =
                    killed["history_imports"][0]["rolled_back_at"].clone();
                assert!(
                    expected == killed,
                    "rollback changed more than active/revision"
                );
            } else {
                assert_eq!(killed["history_imports"].len(), 1);
                assert_eq!(killed["history_messages"].len(), 2);
            }
            save(&root, "killed", &json!(killed));
            let mut reader = spawn(&root, "reopen", operation, after);
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(status) = reader.0.try_wait().unwrap() {
                    assert!(status.success(), "new-exec oracle failed");
                    break;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(load(&root, "done"), json!(true));
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
