//! Author-only child hooks compiled solely in the unit-test binary. No normal
//! build hook, recovery constructor, arbitrary SQL or production environment switch.
use super::tests::{claim, config, ready, setup_at};
use super::*;
use orkestr_v2_contracts::{ConversationId, EventId, MessageId, SessionId};
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Connection};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
pub(super) fn checkpoint(name: &str) {
    if std::env::var("CORE_PRODUCTION_CHECKPOINT").ok().as_deref() != Some(name) {
        return;
    }
    let root =
        PathBuf::from(std::env::var_os("CORE_PRODUCTION_CHILD_ROOT").expect("owned child root"));
    std::fs::write(root.join("marker"), name).unwrap();
    // Bounded even if an owning parent disappears. This is test binary only.
    for _ in 0..300 {
        std::thread::park_timeout(Duration::from_millis(100));
    }
    panic!("parent failed to terminate checkpoint child");
}
struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn spawn(root: &Path, mode: &str, name: &str) -> Owned {
    Owned(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "production_runtime::process_tests::child",
                "--nocapture",
            ])
            .env_clear()
            .env("ORKESTR_V2_HOME", root)
            .env("CORE_PRODUCTION_CHILD_ROOT", root)
            .env("CORE_PRODUCTION_CHILD_MODE", mode)
            .env("CORE_PRODUCTION_CHECKPOINT", name)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    )
}
async fn rows(root: &Path) -> Vec<String> {
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(root.join("core.sqlite3"))
            .read_only(true),
    )
    .await
    .unwrap();
    let mut tx = conn.begin().await.unwrap();
    let mut result = Vec::new();
    for table in [
        "production_supervisors",
        "production_readiness",
        "production_runs",
        "reasoning_inbox",
        "session_bindings",
        "owners",
        "auth_sessions",
        "conversations",
        "messages",
        "events",
        "outbox",
    ] {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap()
            .iter()
            .map(|r| r.get::<String, _>("name"))
            .map(|s| format!("'{s}',{s}"))
            .collect::<Vec<_>>()
            .join(",");
        let values: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT json_object({columns}) FROM {table} ORDER BY 1"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        result.push(format!("{table}:{values:?}"));
    }
    tx.commit().await.unwrap();
    conn.close().await.unwrap();
    result
}
#[tokio::test]
#[ignore = "owned subprocess entry invoked by production parent"]
async fn child() {
    let root = PathBuf::from(std::env::var_os("CORE_PRODUCTION_CHILD_ROOT").unwrap());
    let mode = std::env::var("CORE_PRODUCTION_CHILD_MODE").unwrap();
    if mode == "prepare" {
        let f = setup_at(root.clone()).await;
        let b = ready(&f).await;
        let claim = claim(&f, &b).await;
        let c = f.handle.context().unwrap();
        let deadline: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms FROM production_supervisors WHERE context_id=?",
        )
        .bind(&c.id)
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
        // Public input/locator artifact only. No private context, token, candidate
        // or reservation is serialized or reconstructed across processes.
        std::fs::write(root.join("public.json"),serde_json::to_vec(&json!({"owner":claim.owner_id.to_string(),"conversation":claim.conversation_id.to_string(),"message":claim.message_id.to_string(),"event":claim.event_id.to_string(),"session":claim.consumer_session_id.to_string(),"sequence":claim.scope_sequence,"claim_generation":claim.claim_generation,"claim_deadline":claim.lease_deadline_ms,"binding_generation":b.generation,"predecessor":c.incarnation,"context_deadline":deadline})).unwrap()).unwrap();
        let checkpoint = std::env::var("CORE_PRODUCTION_CHECKPOINT").unwrap();
        if checkpoint.starts_with("admit-") {
            std::fs::write(
                root.join("before.json"),
                serde_json::to_vec(&rows(&root).await).unwrap(),
            )
            .unwrap();
        }
        let fresh = f
            .handle
            .admit_run(&claim, &b.session_id, b.generation, "run:1")
            .await
            .unwrap();
        if checkpoint.starts_with("reserve-") {
            std::fs::write(
                root.join("before.json"),
                serde_json::to_vec(&rows(&root).await).unwrap(),
            )
            .unwrap();
        }
        let DispatchClaimResult::Reserved(reserved) = f
            .handle
            .claim_provider_dispatch(&fresh, "reserve:1")
            .await
            .unwrap()
        else {
            panic!("fresh reservation")
        };
        if checkpoint.starts_with("consume-") {
            std::fs::write(
                root.join("before.json"),
                serde_json::to_vec(&rows(&root).await).unwrap(),
            )
            .unwrap();
        }
        let _ = f.handle.consume_execution(&reserved).await.unwrap();
        panic!("checkpoint was not reached");
    }
    assert_eq!(mode, "recover");
    let v: Value =
        serde_json::from_slice(&std::fs::read(root.join("public.json")).unwrap()).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let token = "ab".repeat(32);
    let predecessor = v["predecessor"].as_str().unwrap().to_owned();
    // No arbitrary context constructor: public authenticated expiry+predecessor CAS only.
    let handle = store
        .authorize_supervisor(
            &token,
            config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: predecessor,
            }),
        )
        .await
        .unwrap();
    let claim = InboxClaim {
        owner_id: OwnerId(Uuid::parse_str(v["owner"].as_str().unwrap()).unwrap()),
        conversation_id: ConversationId(
            Uuid::parse_str(v["conversation"].as_str().unwrap()).unwrap(),
        ),
        message_id: MessageId(Uuid::parse_str(v["message"].as_str().unwrap()).unwrap()),
        event_id: EventId(Uuid::parse_str(v["event"].as_str().unwrap()).unwrap()),
        consumer_session_id: SessionId(Uuid::parse_str(v["session"].as_str().unwrap()).unwrap()),
        scope_sequence: v["sequence"].as_i64().unwrap(),
        claim_generation: v["claim_generation"].as_u64().unwrap(),
        lease_deadline_ms: v["claim_deadline"].as_i64().unwrap(),
    };
    let before = rows(&root).await;
    let result = handle
        .admit_run(
            &claim,
            &claim.consumer_session_id,
            v["binding_generation"].as_u64().unwrap(),
            "run:1",
        )
        .await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    if count == 0 {
        assert!(matches!(
            result,
            Err(RuntimeStoreError::Expired) | Err(RuntimeStoreError::StaleLease)
        ));
    } else {
        let result = result.unwrap();
        assert_eq!(
            result.disposition,
            AdmissionDisposition::ReconciliationRequired
        );
        assert!(result.candidate_key.is_none());
        assert_eq!(result.run_state, RunState::Blocked);
        let mut changed = claim.clone();
        changed.message_id = MessageId(Uuid::new_v4());
        assert_eq!(
            handle
                .admit_run(
                    &changed,
                    &claim.consumer_session_id,
                    v["binding_generation"].as_u64().unwrap(),
                    "run:1"
                )
                .await
                .unwrap_err(),
            RuntimeStoreError::Conflict
        );
    }
    assert_eq!(before, rows(&root).await);
    store.close().await;
}
#[tokio::test]
async fn actual_process_crashes_preserve_atomic_ack_and_never_reissue_dispatch() {
    let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("production-process-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let names = [
        "admit-before-ack",
        "admit-before-commit",
        "admit-after-commit",
        "reserve-before-commit",
        "reserve-after-commit",
        "consume-before-commit",
        "consume-after-commit",
    ];
    let mut cases = Vec::new();
    for name in names {
        let path = root.join(name);
        std::fs::create_dir(&path).unwrap();
        cases.push((path.clone(), name, spawn(&path, "prepare", name)));
    }
    let start = Instant::now();
    for (path, name, child) in &mut cases {
        while !path.join("marker").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child exited before {name}"
            );
            assert!(start.elapsed() < Duration::from_secs(20));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(std::fs::read_to_string(path.join("marker")).unwrap(), *name);
        child.0.kill().unwrap();
        let status = child.0.wait().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(9));
        let before: Vec<String> =
            serde_json::from_slice(&std::fs::read(path.join("before.json")).unwrap()).unwrap();
        let after = rows(path).await;
        if name.contains("before-") {
            assert_eq!(before, after, "rollback {name}");
        } else {
            assert_ne!(before, after, "committed {name}");
        }
        let mut conn = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(path.join("core.sqlite3"))
                .read_only(true),
        )
        .await
        .unwrap();
        let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let ack:i64=sqlx::query_scalar("SELECT count(*) FROM reasoning_inbox WHERE state='consumed' AND admitted_run_id IS NOT NULL").fetch_one(&mut conn).await.unwrap();
        assert_eq!(runs, ack);
        if *name == "consume-after-commit" {
            let state: String = sqlx::query_scalar("SELECT dispatch_state FROM production_runs")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(state, "delivery_unknown");
        }
        conn.close().await.unwrap();
    }
    // All contexts expire concurrently on real SQLite time; no clock mutation.
    loop {
        let mut wait = false;
        for (path, _, _) in &cases {
            let v: Value =
                serde_json::from_slice(&std::fs::read(path.join("public.json")).unwrap()).unwrap();
            let clock = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            if clock <= v["context_deadline"].as_i64().unwrap() + 20 {
                wait = true;
            }
        }
        if !wait {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(75));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut recovery = cases
        .iter()
        .map(|(path, _, _)| spawn(path, "recover", ""))
        .collect::<Vec<_>>();
    for child in &mut recovery {
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(90));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}
