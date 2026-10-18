//! Independent public-hook crash probes. No private authority survives exec.
use super::*;
use orkestr_v2_store_sqlite::ProductionCheckpoint;
use std::process::{Child, Command, Stdio};
use std::time::Instant;
const TOKEN: &str = "abababababababababababababababababababababababababababababababab";
const STAGES: [(&str, ProductionCheckpoint); 7] = [
    ("admit-before-ack", ProductionCheckpoint::AdmitBeforeAck),
    (
        "admit-before-commit",
        ProductionCheckpoint::AdmitBeforeCommit,
    ),
    ("admit-after-commit", ProductionCheckpoint::AdmitAfterCommit),
    (
        "reserve-before-commit",
        ProductionCheckpoint::ReserveBeforeCommit,
    ),
    (
        "reserve-after-commit",
        ProductionCheckpoint::ReserveAfterCommit,
    ),
    (
        "consume-before-commit",
        ProductionCheckpoint::ConsumeBeforeCommit,
    ),
    (
        "consume-after-commit",
        ProductionCheckpoint::ConsumeAfterCommit,
    ),
];
pub(super) struct Owned(pub(super) Child);
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
pub(super) fn spawn(root: &std::path::Path, mode: &str, stage: &str) -> Owned {
    Owned(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "process::owned_child",
                "--nocapture",
            ])
            .env_clear()
            .env("ORKESTR_V2_HOME", root)
            .env("INDEPENDENT_CHILD_MODE", mode)
            .env("INDEPENDENT_STAGE", stage)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    )
}
#[tokio::test]
#[ignore = "only the owning process parent invokes this entry"]
async fn owned_child() {
    let base = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    let stage = std::env::var("INDEPENDENT_STAGE").unwrap();
    let mode = std::env::var("INDEPENDENT_CHILD_MODE").unwrap();
    if mode == "successor" {
        super::process_successor::recover(&base, &stage).await;
        return;
    }
    if mode == "probe" || mode == "busy" {
        let root = PathBuf::from(std::fs::read_to_string(base.join("case-path")).unwrap());
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let predecessor = std::fs::read_to_string(base.join("predecessor")).unwrap();
        let mut cfg = config();
        cfg.takeover = ProductionTakeover::ExpiredPredecessor {
            incarnation_id: predecessor.clone(),
        };
        assert!(matches!(
            store.authorize_supervisor(TOKEN, cfg).await,
            Err(RuntimeStoreError::Busy)
        ));
        if mode == "busy" {
            store.close().await;
            return;
        }
        let mut cfg = config();
        cfg.takeover = ProductionTakeover::ExpiredPredecessor {
            incarnation_id: predecessor,
        };
        store.revoke_session(TOKEN).await.unwrap();
        assert!(matches!(
            store.authorize_supervisor(TOKEN, cfg).await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        store.close().await;
        return;
    }
    let c = Case::new().await;
    c.store.save_session(TOKEN, &c.owner).await.unwrap();
    let mut h = c.store.authorize_supervisor(TOKEN, config()).await.unwrap();
    let (binding, claim) = c.ready_claim(&h).await;
    std::fs::write(base.join("case-path"), c.root.to_str().unwrap()).unwrap();
    std::fs::write(
        base.join("predecessor"),
        h.supervisor_incarnation().unwrap(),
    )
    .unwrap();
    std::fs::write(
        base.join("input.json"),
        serde_json::to_vec(&serde_json::json!({
            "owner": claim.owner_id.to_string(), "conversation": claim.conversation_id.to_string(),
            "message": claim.message_id.to_string(), "event": claim.event_id.to_string(),
            "session": claim.consumer_session_id.to_string(), "sequence": claim.scope_sequence,
            "claim_generation": claim.claim_generation, "claim_deadline": claim.lease_deadline_ms,
            "binding_generation": binding.generation
        }))
        .unwrap(),
    )
    .unwrap();
    let checkpoint = STAGES.iter().find(|(s, _)| *s == stage).unwrap().1;
    h.production_arm_checkpoint(checkpoint, base.join("marker"))
        .await
        .unwrap();
    if stage.starts_with("admit") {
        save_before(&c, &base).await;
    }
    let admission = h
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "independent-crash:1",
        )
        .await
        .unwrap();
    std::fs::write(
        base.join("receipt.json"),
        serde_json::to_vec(&super::process_successor::envelope(&admission.provider)).unwrap(),
    )
    .unwrap();
    if stage.starts_with("reserve") {
        save_before(&c, &base).await;
    }
    let DispatchClaimResult::Reserved(reservation) = h
        .claim_provider_dispatch(&admission, "independent-reserve:1")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    if stage.starts_with("consume") {
        save_before(&c, &base).await;
    }
    let _ = h.consume_execution(&reservation).await.unwrap();
    panic!("checkpoint failed to stop child");
}
async fn save_before(c: &Case, base: &std::path::Path) {
    std::fs::write(
        base.join("oracle-before.json"),
        serde_json::to_vec(&super::process_oracle::rows(&c.root).await).unwrap(),
    )
    .unwrap();
    std::fs::write(
        base.join("before.json"),
        serde_json::to_vec(&c.rows().await).unwrap(),
    )
    .unwrap();
}
#[tokio::test]
async fn independent_seven_sigkill_windows_and_new_exec_revocation() {
    use std::os::unix::process::ExitStatusExt;
    for (stage, _) in STAGES {
        let base = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&base).unwrap();
        let mut child = spawn(&base, "prepare", stage);
        let deadline = Instant::now() + Duration::from_secs(20);
        while !base.join("marker").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child exited before checkpoint"
            );
            assert!(Instant::now() < deadline, "checkpoint timed out");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(std::fs::read_to_string(base.join("marker")).unwrap(), stage);
        child.0.kill().unwrap();
        assert_eq!(child.0.wait().unwrap().signal(), Some(9));
        let root = PathBuf::from(std::fs::read_to_string(base.join("case-path")).unwrap());
        // Reuse only the read-only full-row oracle, never a context or capability.
        let before: Vec<String> =
            serde_json::from_slice(&std::fs::read(base.join("before.json")).unwrap()).unwrap();
        let after = snapshot_rows(&root).await;
        if stage.ends_with("after-commit") {
            assert_ne!(before, after, "committed stage");
        } else {
            assert_eq!(before, after, "transaction must roll back");
        }
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
        let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let ack: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM reasoning_inbox WHERE admitted_run_id IS NOT NULL",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(runs, ack);
        if stage == "consume-after-commit" {
            let state: String = sqlx::query_scalar("SELECT dispatch_state FROM production_runs")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(state, "delivery_unknown");
        }
        tx.commit().await.unwrap();
        db.close().await.unwrap();
        let mut fresh = spawn(&base, "probe", stage);
        assert!(
            fresh.0.wait().unwrap().success(),
            "new-exec busy/revocation probe"
        );
        assert_eq!(
            after,
            snapshot_rows(&root).await,
            "refused takeover and auth revocation must preserve run ledger"
        );
        std::fs::remove_dir_all(base).unwrap();
    }
}
