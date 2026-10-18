//! Independently authored owned-child SIGKILL oracles. No private handle reconstruction.
#![cfg(feature = "fixture-test-controls")]
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::MessageInput;
use orkestr_v2_store_sqlite::{
    fixture_runtime::{test_controls::FixtureCheckpoint, *},
    Store,
};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[tokio::test]
#[ignore = "owned child entry; invoked by independent parent"]
async fn independent_checkpoint_child() {
    let Some(root) = std::env::var_os("INDEPENDENT_CHECKPOINT_ROOT") else {
        panic!("owned child only")
    };
    let root = PathBuf::from(root);
    let store = Store::open(&root.join("case.sqlite3")).await.unwrap();
    let conversation = store.setup("synthetic", "synthetic-hash").await.unwrap();
    let owner = store.credentials("synthetic").await.unwrap().unwrap().0;
    let mut h = bootstrap_fixture_supervisor(
        &store,
        &owner,
        ExplicitFixtureSupervisorConfig {
            namespace: "independent-crash".into(),
            supervisor_key: "child".into(),
            takeover: FixtureTakeover::First,
        },
    )
    .await
    .unwrap();
    let roles = store
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap();
    let binding = h
        .confirm_fixture_readiness(&roles.deep.session_id, 1)
        .await
        .unwrap();
    store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "input".into(),
                text: "Synthetic crash case".into(),
            },
        )
        .await
        .unwrap();
    let claim = store
        .claim_next(
            &owner,
            &conversation,
            &binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let stage = std::env::var("INDEPENDENT_CHECKPOINT_STAGE").unwrap();
    if stage == "consume-after-commit" {
        let candidate = h
            .admit_run(&claim, &binding.session_id, binding.generation, "run")
            .await
            .unwrap();
        let reservation = match h
            .claim_provider_dispatch(&candidate, "reserve")
            .await
            .unwrap()
        {
            DispatchClaimResult::Reserved(r) => r,
            _ => panic!("reservation"),
        };
        h.fixture_arm_checkpoint(
            FixtureCheckpoint::ConsumeAfterCommit,
            root.join("checkpoint"),
        )
        .await
        .unwrap();
        let _ = h.consume_provider_dispatch(&reservation).await;
    } else {
        let point = match stage.as_str() {
            "admit-before-ack" => FixtureCheckpoint::AdmitBeforeAck,
            "admit-after-commit" => FixtureCheckpoint::AdmitAfterCommit,
            _ => panic!("stage"),
        };
        h.fixture_arm_checkpoint(point, root.join("checkpoint"))
            .await
            .unwrap();
        let _ = h
            .admit_run(&claim, &binding.session_id, binding.generation, "run")
            .await;
    }
    panic!("parent must kill before checkpoint returns");
}
#[tokio::test]
async fn independent_sigkill_before_ack_and_after_commit_has_exact_durable_rows() {
    for stage in [
        "admit-before-ack",
        "admit-after-commit",
        "consume-after-commit",
    ] {
        let base = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"));
        let root = Root(
            base.join(format!(
                "independent-kill-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )),
        );
        std::fs::create_dir(&root.0).unwrap();
        let mut child = OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", "independent_checkpoint_child"])
                .env_clear()
                .env("ORKESTR_V2_HOME", &root.0)
                .env("INDEPENDENT_CHECKPOINT_ROOT", &root.0)
                .env("INDEPENDENT_CHECKPOINT_STAGE", stage)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(bytes) = std::fs::read(root.0.join("checkpoint")) {
                if bytes == stage.as_bytes() {
                    break;
                }
            }
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child exited before checkpoint"
            );
            assert!(Instant::now() < until, "checkpoint timeout");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        // Read-only source connection, one snapshot. No migration, private authority or SQL writes.
        let opts = SqliteConnectOptions::new()
            .filename(root.0.join("case.sqlite3"))
            .read_only(true);
        let mut db = SqliteConnection::connect_with(&opts).await.unwrap();
        sqlx::query("PRAGMA query_only=ON")
            .execute(&mut db)
            .await
            .unwrap();
        let mut tx = db.begin().await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM fixture_runs")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let ack:i64=sqlx::query_scalar("SELECT count(*) FROM reasoning_inbox WHERE state='consumed' AND admitted_fixture_run_id IS NOT NULL").fetch_one(&mut *tx).await.unwrap();
        if stage == "admit-before-ack" {
            assert_eq!((count, ack), (0, 0));
        } else {
            assert_eq!((count, ack), (1, 1));
            let row=sqlx::query("SELECT dispatch_state,candidate_hash IS NOT NULL AS candidate,reservation_hash IS NOT NULL AS reservation FROM fixture_runs").fetch_one(&mut *tx).await.unwrap();
            assert_eq!(
                row.get::<String, _>("dispatch_state"),
                if stage == "consume-after-commit" {
                    "delivery_unknown"
                } else {
                    "candidate"
                }
            );
            assert_eq!(
                row.get::<i64, _>("candidate"),
                if stage == "consume-after-commit" {
                    0
                } else {
                    1
                }
            );
            assert_eq!(row.get::<i64, _>("reservation"), 0);
        }
        tx.commit().await.unwrap();
        db.close().await.unwrap();
    }
}
