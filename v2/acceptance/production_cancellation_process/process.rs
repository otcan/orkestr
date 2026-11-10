//! Actual owned-child SIGKILL; public authorization only, no recovered handle.
use super::*;
use orkestr_v2_store_sqlite::ProductionCheckpoint;
use serde_json::{json, Value};
use std::process::{Child, Command, Stdio};
use std::time::Instant;
const TOKEN: &str = "abababababababababababababababababababababababababababababababab";
const STAGES: [(&str, ProductionCheckpoint); 4] = [
    (
        "cancel-before-commit",
        ProductionCheckpoint::CancelBeforeCommit,
    ),
    (
        "cancel-after-commit",
        ProductionCheckpoint::CancelAfterCommit,
    ),
    (
        "stopped-before-commit",
        ProductionCheckpoint::StoppedBeforeCommit,
    ),
    (
        "stopped-after-commit",
        ProductionCheckpoint::StoppedAfterCommit,
    ),
];
struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn spawn(base: &std::path::Path, stage: &str, mode: &str) -> Owned {
    Owned(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "process::owned_child",
                "--nocapture",
            ])
            .env_clear()
            .env("ORKESTR_V2_HOME", base)
            .env("STAGE", stage)
            .env("MODE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    )
}
fn save(base: &std::path::Path, name: &str, value: Value) {
    std::fs::write(base.join(name), serde_json::to_vec(&value).unwrap()).unwrap();
}
fn load(base: &std::path::Path, name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(base.join(name)).unwrap()).unwrap()
}
fn event(p: &ProviderAdmission, sequence: u64, event: ProviderEvent) -> ProviderEventInput {
    ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        sequence,
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        event,
    }
}
#[tokio::test]
#[ignore = "invoked only by owning parent"]
async fn owned_child() {
    let base = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    let stage = std::env::var("STAGE").unwrap();
    if std::env::var("MODE").unwrap() == "reopen" {
        let root = PathBuf::from(load(&base, "root.json").as_str().unwrap());
        let expected: oracle::Rows = serde_json::from_value(load(&base, "killed.json")).unwrap();
        assert!(
            oracle::rows(&root).await == expected,
            "fresh exec readonly equality"
        );
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        assert!(
            oracle::rows(&root).await == expected,
            "Store reopen equality"
        );
        let mut cfg = config();
        cfg.takeover = ProductionTakeover::ExpiredPredecessor {
            incarnation_id: load(&base, "predecessor.json").as_str().unwrap().into(),
        };
        assert!(matches!(
            store.authorize_supervisor(TOKEN, cfg).await,
            Err(RuntimeStoreError::Busy)
        ));
        assert!(
            oracle::rows(&root).await == expected,
            "Busy cannot mutate ledger"
        );
        store.revoke_session(TOKEN).await.unwrap();
        let mut cfg = config();
        cfg.takeover = ProductionTakeover::ExpiredPredecessor {
            incarnation_id: load(&base, "predecessor.json").as_str().unwrap().into(),
        };
        assert!(matches!(
            store.authorize_supervisor(TOKEN, cfg).await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert!(
            oracle::rows(&root).await == expected,
            "revocation cannot mutate journal"
        );
        store.close().await;
        return;
    }
    let c = Case::new().await;
    c.store.save_session(TOKEN, &c.owner).await.unwrap();
    let mut h = c.store.authorize_supervisor(TOKEN, config()).await.unwrap();
    let (b, claim) = c.ready_claim(&h).await;
    let run = h
        .admit_run(&claim, &b.session_id, b.generation, "cancel-crash:1")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) =
        h.claim_provider_dispatch(&run, "reserve:1").await.unwrap()
    else {
        panic!("fresh reserve")
    };
    assert!(matches!(
        h.consume_execution(&reservation).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    h.append_provider_event(
        &c.owner,
        &run.provider,
        &event(&run.provider, 1, ProviderEvent::Started),
    )
    .await
    .unwrap();
    save(&base, "root.json", json!(c.root));
    save(
        &base,
        "predecessor.json",
        json!(h.supervisor_incarnation().unwrap()),
    );
    let checkpoint = STAGES.iter().find(|(name, _)| *name == stage).unwrap().1;
    if stage.starts_with("stopped") {
        let cancel = h
            .request_cancel(&c.owner, &run.provider.run.run_id, "cancel:1")
            .await
            .unwrap();
        assert_eq!(cancel.inflight_status, InflightStatus::Unknown);
        let mut control = run.provider.clone();
        control.run = cancel.new_fenced_admission;
        save(&base, "before.json", json!(oracle::rows(&c.root).await));
        h.production_arm_checkpoint(checkpoint, base.join("marker"))
            .await
            .unwrap();
        let _ = h
            .append_provider_event(
                &c.owner,
                &control,
                &event(&control, 2, ProviderEvent::Stopped),
            )
            .await;
    } else {
        save(&base, "before.json", json!(oracle::rows(&c.root).await));
        h.production_arm_checkpoint(checkpoint, base.join("marker"))
            .await
            .unwrap();
        let _ = h
            .request_cancel(&c.owner, &run.provider.run.run_id, "cancel:1")
            .await;
    }
    panic!("parent must kill child at marker");
}
fn delta(before: &oracle::Rows, after: &oracle::Rows, stage: &str) {
    if stage.ends_with("before-commit") {
        assert!(before == after, "precommit must have zero partial writes");
        return;
    }
    let stopping = stage.starts_with("stopped");
    let mut expected = before.clone();
    // Exact unchanged rows/columns except the explicitly checked transaction writes.
    for table in ["events", "outbox"] {
        let added = &after[table][before[table].len()..];
        assert_eq!(added.len(), 1, "one journal/outbox row");
        expected.get_mut(table).unwrap().extend_from_slice(added);
    }
    let journal = after["events"].last().unwrap();
    assert_eq!(
        journal["kind"],
        if stopping {
            "provider_stopped"
        } else {
            "cancellation_requested"
        }
    );
    assert_eq!(journal["schema_version"], if stopping { 7 } else { 6 });
    assert_eq!(journal["message_id"], Value::Null);
    Uuid::parse_str(journal["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        journal["owner_id"],
        before["production_runs"][0]["owner_id"]
    );
    assert_eq!(
        journal["conversation_id"],
        before["production_runs"][0]["conversation_id"]
    );
    assert_eq!(
        after["outbox"].last().unwrap(),
        &json!({"event_id":journal["id"],"state":"pending"})
    );
    assert_eq!(after["outbox"].last().unwrap()["event_id"], journal["id"]);
    let old_sequence = before["conversations"][0]["sequence"].as_i64().unwrap();
    assert_eq!(journal["sequence"], old_sequence + 1);
    expected.get_mut("conversations").unwrap()[0]["sequence"] = json!(old_sequence + 1);
    let run = &mut expected.get_mut("production_runs").unwrap()[0];
    run["state"] = json!(if stopping {
        "cancelled"
    } else {
        "cancel_requested"
    });
    for field in ["candidate_hash", "reservation_hash", "reserve_key"] {
        run[field] = Value::Null;
    }
    if stopping {
        let observed = after["production_observations"].last().unwrap();
        assert_eq!(
            after["production_observations"].len(),
            before["production_observations"].len() + 1
        );
        assert_eq!(observed["event_id"], journal["id"]);
        assert_eq!(observed["kind"], "stopped");
        let digest = observed["semantic_digest"].as_str().unwrap();
        assert!(digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(observed["receipt_state"], "cancelled");
        assert_eq!(observed["run_sequence"], 2);
        assert_eq!(observed["run_id"], run["id"]);
        assert_eq!(observed["lease_generation"], run["lease_generation"]);
        assert_eq!(observed["dispatch_fence"], run["dispatch_fence"]);
        expected
            .get_mut("production_observations")
            .unwrap()
            .push(observed.clone());
        expected.get_mut("production_control_outbox").unwrap()[0]["state"] = json!("acknowledged");
        let b = expected
            .get_mut("session_bindings")
            .unwrap()
            .iter_mut()
            .find(|b| b["role"] == "deep")
            .unwrap();
        b["state"] = json!("ready");
        b["generation"] = json!(b["generation"].as_i64().unwrap() + 1);
    } else {
        let lease = after["production_run_leases"].last().unwrap();
        assert_eq!(
            after["production_run_leases"].len(),
            before["production_run_leases"].len() + 1
        );
        assert_eq!(lease["run_id"], run["id"]);
        assert_eq!(lease["purpose"], "cancellation_acknowledgement");
        assert!(
            lease["lease_deadline_ms"].as_i64().unwrap()
                <= before["production_supervisors"][0]["lease_deadline_ms"]
                    .as_i64()
                    .unwrap()
        );
        assert!(
            lease["lease_deadline_ms"].as_i64().unwrap()
                >= run["lease_deadline_ms"].as_i64().unwrap()
        );
        assert_eq!(
            lease["generation"],
            run["lease_generation"].as_i64().unwrap() + 1
        );
        assert_eq!(
            lease["dispatch_fence"],
            run["dispatch_fence"].as_i64().unwrap() + 1
        );
        for field in ["dispatch_fence", "lease_deadline_ms"] {
            run[field] = lease[field].clone();
        }
        run["lease_generation"] = lease["generation"].clone();
        let cancel = &after["production_cancellations"][0];
        assert_eq!(after["production_cancellations"].len(), 1);
        assert_eq!(cancel["run_id"], run["id"]);
        assert_eq!(cancel["event_id"], journal["id"]);
        assert_eq!(cancel["request_key"], "cancel:1");
        assert_eq!(cancel["receipt_state"], "cancel_requested");
        assert_eq!(cancel["inflight_status"], "unknown");
        for field in ["lease_generation", "dispatch_fence", "lease_deadline_ms"] {
            assert_eq!(cancel[field], run[field]);
        }
        let control_row = json!({"event_id":journal["id"],"run_id":run["id"],"state":"pending"});
        expected.insert("production_cancellations".into(), vec![cancel.clone()]);
        expected.insert("production_control_outbox".into(), vec![control_row]);
        expected
            .get_mut("production_run_leases")
            .unwrap()
            .push(lease.clone());
    }
    let rev = &mut expected.get_mut("execution_revisions").unwrap()[0]["revision"];
    *rev = json!(rev.as_i64().unwrap() + 1);
    for (table, rows) in expected {
        assert!(
            after[&table] == rows,
            "unexpected full-row delta in {table}"
        );
    }
}
#[tokio::test]
async fn independent_four_cancel_stopped_sigkill_windows_and_fresh_exec() {
    use std::os::unix::process::ExitStatusExt;
    let suite = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&suite).unwrap();
    for (stage, _) in STAGES {
        let base = suite.join(stage);
        std::fs::create_dir(&base).unwrap();
        let mut child = spawn(&base, stage, "prepare");
        let start = Instant::now();
        while !base.join("marker").exists() {
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "bounded marker wait"
            );
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child exited before marker"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            std::fs::read(base.join("marker")).unwrap(),
            stage.as_bytes()
        );
        child.0.kill().unwrap();
        assert_eq!(child.0.wait().unwrap().signal(), Some(9));
        let root = PathBuf::from(load(&base, "root.json").as_str().unwrap());
        let before: oracle::Rows = serde_json::from_value(load(&base, "before.json")).unwrap();
        let after = oracle::rows(&root).await;
        delta(&before, &after, stage);
        save(&base, "killed.json", json!(after));
        let mut reopen = spawn(&base, stage, "reopen");
        let start = Instant::now();
        loop {
            if let Some(status) = reopen.0.try_wait().unwrap() {
                assert!(status.success(), "fresh exec failed");
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "bounded fresh exec"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    std::fs::remove_dir_all(suite).unwrap();
}
