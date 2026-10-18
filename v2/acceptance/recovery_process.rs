//! Independently authored actual-method SIGKILL and new-exec dormant-ledger oracle.
#![cfg(feature = "fixture-test-controls")]
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::history_import::{
    history_recovery_digest, HistoryRecoveryBundle, HistoryRecoveryRestoreRequest,
    HistoryRecoveryRollbackRequest,
};
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
const TOKEN: &str = "synthetic-recovery-process-session";
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
        if ![
            "history_imports",
            "history_messages",
            "history_recovery_restores",
            "history_recovery_children",
        ]
        .contains(&table.as_str())
        {
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
            .args(["--ignored", "--exact", "recovery_child"])
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
fn request(root: &Path) -> HistoryRecoveryRestoreRequest {
    let value = load(root, "request");
    let mut bundle = HistoryRecoveryBundle {
        schema_version: 1,
        original: serde_json::from_value(value["original"].clone()).unwrap(),
        current_receipt: serde_json::from_value(value["receipt"].clone()).unwrap(),
        native_delta: serde_json::from_value(value["delta"].clone()).unwrap(),
        bundle_digest: value["digest"].as_str().unwrap().into(),
    };
    assert_eq!(
        history_recovery_digest(&bundle).unwrap(),
        bundle.bundle_digest
    );
    HistoryRecoveryRestoreRequest {
        restore_id: serde_json::from_value(value["id"].clone()).unwrap(),
        original_namespace: serde_json::from_value(value["target_original"].clone()).unwrap(),
        delta_namespace: serde_json::from_value(value["target_delta"].clone()).unwrap(),
        bundle: {
            bundle.schema_version = 1;
            bundle
        },
    }
}
fn rollback(input: &HistoryRecoveryRestoreRequest) -> HistoryRecoveryRollbackRequest {
    HistoryRecoveryRollbackRequest {
        restore_id: input.restore_id,
        expected_revision: 1,
        request_key: "synthetic-whole-rollback".into(),
    }
}
include!("recovery_process_support/oracle.rs");
fn receipt_value(
    r: &orkestr_v2_store_sqlite::history_import::HistoryRecoveryRestoreReceipt,
) -> Value {
    json!({"id":r.restore_id,"digest":r.bundle_digest,"original":r.original,"delta":r.native_delta})
}
async fn initialize(root: &Path, store: &mut Store) -> OwnerId {
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
                text: "Unchanged ordinary intake".into(),
            },
        )
        .await
        .unwrap();
    let mut original = HistoryImportRequest {
        namespace: Uuid::new_v4(),
        source_digest: String::new(),
        source_conversation_id: ConversationId(Uuid::new_v4()),
        source_scope: Scope::Global,
        source_watermark: 7,
        messages: vec![Message {
            message_id: MessageId(Uuid::new_v4()),
            sequence: 7,
            actor_kind: "owner".into(),
            text: "Synthetic inactive original é".into(),
        }],
    };
    original.source_digest = history_source_digest(&original).unwrap();
    let mut delta = original.clone();
    delta.namespace = Uuid::new_v4();
    delta.source_conversation_id = ConversationId(Uuid::new_v4());
    delta.messages[0].message_id = MessageId(Uuid::new_v4());
    delta.messages[0].text = "Synthetic native delta".into();
    delta.source_digest = history_source_digest(&delta).unwrap();
    let source_receipt = HistoryImportReceipt {
        schema_version: 1,
        owner_id: OwnerId(Uuid::new_v4()),
        namespace: original.namespace,
        source_digest: original.source_digest.clone(),
        source_conversation_id: original.source_conversation_id.clone(),
        source_watermark: 7,
        message_count: 1,
        revision: 2,
        active: false,
    };
    let mut bundle = HistoryRecoveryBundle {
        schema_version: 1,
        original,
        current_receipt: source_receipt,
        native_delta: delta,
        bundle_digest: String::new(),
    };
    bundle.bundle_digest = history_recovery_digest(&bundle).unwrap();
    save(
        root,
        "request",
        &json!({"id":Uuid::new_v4(),"original":bundle.original,"receipt":bundle.current_receipt,"delta":bundle.native_delta,"digest":bundle.bundle_digest,"target_original":Uuid::new_v4(),"target_delta":Uuid::new_v4()}),
    );
    save(root, "owner", &json!(owner));
    owner
}
#[tokio::test]
#[ignore = "owned child entry invoked by independent parent"]
async fn recovery_child() {
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    let is_rollback = std::env::var("OPERATION").unwrap() == "rollback";
    let after = std::env::var("AFTER").unwrap() == "1";
    if std::env::var("MODE").unwrap() == "writer" {
        let mut store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let owner = initialize(&root, &mut store).await;
        let input = request(&root);
        if is_rollback {
            store
                .restore_history_recovery(TOKEN, &owner, &input)
                .await
                .unwrap();
        }
        save(&root, "before", &json!(snapshot(&root).await));
        let stage = match (is_rollback, after) {
            (false, false) => ProductionCheckpoint::RecoveryRestoreBeforeCommit,
            (false, true) => ProductionCheckpoint::RecoveryRestoreAfterCommit,
            (true, false) => ProductionCheckpoint::RecoveryRollbackBeforeCommit,
            (true, true) => ProductionCheckpoint::RecoveryRollbackAfterCommit,
        };
        store
            .production_arm_history_checkpoint(TOKEN, &owner, stage, root.join("marker"))
            .await
            .unwrap();
        if is_rollback {
            let _ = store
                .rollback_history_recovery(TOKEN, &owner, &rollback(&input))
                .await;
        } else {
            let _ = store.restore_history_recovery(TOKEN, &owner, &input).await;
        }
        panic!("writer returned without owned SIGKILL");
    }
    let killed: Rows = serde_json::from_value(load(&root, "killed")).unwrap();
    assert!(
        snapshot(&root).await == killed,
        "new-exec pre-open changed rows"
    );
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    assert!(snapshot(&root).await == killed, "open changed rows");
    let owner: OwnerId = serde_json::from_value(load(&root, "owner")).unwrap();
    let input = request(&root);
    let before: Rows = serde_json::from_value(load(&root, "before")).unwrap();
    if is_rollback {
        let r = store
            .rollback_history_recovery(TOKEN, &owner, &rollback(&input))
            .await
            .unwrap();
        assert_eq!((r.revision, r.active), (2, false));
    }
    let restored = store
        .restore_history_recovery(TOKEN, &owner, &input)
        .await
        .unwrap();
    assert_eq!(restored.restore_id, input.restore_id);
    assert_eq!(restored.bundle_digest, input.bundle.bundle_digest);
    assert_eq!(restored.original.owner_id, owner);
    assert_eq!(
        (restored.original.revision, restored.original.active),
        (2, false)
    );
    assert_eq!(
        (restored.native_delta.revision, restored.native_delta.active),
        (1, true)
    );
    assert_eq!(restored.original.namespace, input.original_namespace);
    assert_eq!(restored.native_delta.namespace, input.delta_namespace);
    assert!(store
        .history_messages(TOKEN, &owner, input.original_namespace, None, 100)
        .await
        .unwrap()
        .is_empty());
    let delta = store
        .history_messages(TOKEN, &owner, input.delta_namespace, None, 100)
        .await
        .unwrap();
    if is_rollback {
        assert!(delta.is_empty());
    } else {
        assert_eq!(
            serde_json::to_value(delta).unwrap(),
            json!(input.bundle.native_delta.messages)
        );
    }
    let committed = snapshot(&root).await;
    inert(&before, &committed);
    if after {
        assert!(committed == killed, "lost receipt retry changed rows");
    }
    let first = receipt_value(&restored);
    let repeated = store
        .restore_history_recovery(TOKEN, &owner, &input)
        .await
        .unwrap();
    assert_eq!(receipt_value(&repeated), first);
    let mut changed = input.clone();
    changed.bundle.original.messages[0].text.push('!');
    changed.bundle.original.source_digest =
        history_source_digest(&changed.bundle.original).unwrap();
    changed.bundle.current_receipt.source_digest = changed.bundle.original.source_digest.clone();
    changed.bundle.bundle_digest = history_recovery_digest(&changed.bundle).unwrap();
    assert!(matches!(
        store
            .restore_history_recovery(TOKEN, &owner, &changed)
            .await,
        Err(HistoryError::Conflict)
    ));
    assert!(snapshot(&root).await == committed);
    store.revoke_session(TOKEN).await.unwrap();
    let revoked = snapshot(&root).await;
    store.close().await;
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    assert!(matches!(
        store.restore_history_recovery(TOKEN, &owner, &input).await,
        Err(HistoryError::Unauthorized)
    ));
    assert!(matches!(
        store
            .rollback_history_recovery(TOKEN, &owner, &rollback(&input))
            .await,
        Err(HistoryError::Unauthorized)
    ));
    assert!(snapshot(&root).await == revoked);
    save(&root, "done", &json!(true));
}
#[test]
fn recovery_restore_and_whole_rollback_four_sigkill_windows() {
    let base = std::path::PathBuf::from(
        std::env::var_os("ORKESTR_V2_HOME").expect("isolated home required"),
    );
    std::fs::create_dir_all(&base).unwrap();
    for operation in ["restore", "rollback"] {
        for after in [false, true] {
            let root = base.join(format!("recovery-process-{}", Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let mut writer = spawn(&root, "writer", operation, after);
            let expected = format!(
                "recovery-{operation}-{}-commit",
                if after { "after" } else { "before" }
            );
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if std::fs::read(root.join("marker")).is_ok_and(|b| b == expected.as_bytes()) {
                    break;
                }
                assert!(
                    writer.0.try_wait().unwrap().is_none(),
                    "writer exited before marker"
                );
                assert!(Instant::now() < deadline, "checkpoint timeout");
                std::thread::sleep(Duration::from_millis(5));
            }
            writer.0.kill().unwrap();
            let status = writer.0.wait().unwrap();
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(9));
            let rt = tokio::runtime::Runtime::new().unwrap();
            let before: Rows = serde_json::from_value(load(&root, "before")).unwrap();
            let killed = rt.block_on(snapshot(&root));
            inert(&before, &killed);
            if !after {
                assert!(before == killed, "precommit partial rows");
            } else if operation == "rollback" {
                let mut expected = before.clone();
                for row in expected.get_mut("history_imports").unwrap() {
                    if row["active"] == json!(1) {
                        row["active"] = json!(0);
                        row["revision"] = json!(2);
                        let actual = killed["history_imports"]
                            .iter()
                            .find(|r| r["namespace"] == row["namespace"])
                            .unwrap();
                        assert!(actual["rolled_back_at"].as_i64().is_some_and(|t| t > 0));
                        row["rolled_back_at"] = actual["rolled_back_at"].clone();
                    }
                }
                let row = &mut expected.get_mut("history_recovery_restores").unwrap()[0];
                let actual = &killed["history_recovery_restores"][0];
                row["revision"] = json!(2);
                row["state"] = json!("rolled_back");
                row["rollback_request_key"] = json!("synthetic-whole-rollback");
                let r: Value =
                    serde_json::from_str(actual["rollback_receipt"].as_str().unwrap()).unwrap();
                assert_eq!(
                    r,
                    json!({"restore_id":row["restore_id"],"revision":2,"active":false})
                );
                assert!(actual["rollback_request_digest"]
                    .as_str()
                    .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())));
                assert!(actual["rolled_back_at"].as_i64().is_some_and(|t| t > 0));
                for field in [
                    "rollback_request_digest",
                    "rollback_receipt",
                    "rolled_back_at",
                ] {
                    row[field] = actual[field].clone();
                }
                assert!(expected == killed, "whole rollback changed unexpected rows");
            } else {
                verify_restored_rows(&root, &killed);
                assert_eq!(killed["history_imports"].len(), 2);
                assert_eq!(killed["history_messages"].len(), 2);
                assert_eq!(killed["history_recovery_restores"].len(), 1);
                assert_eq!(killed["history_recovery_children"].len(), 2);
                assert_eq!(
                    killed["history_recovery_restores"][0]["state"],
                    json!("active")
                );
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
