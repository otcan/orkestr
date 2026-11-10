//! Public checkpoints and actual SIGKILL, followed by a genuinely fresh executable.
use super::*;
use orkestr_v2_store_sqlite::ProductionCheckpoint;
use serde_json::{json, Value};
use std::{
    process::{Child, Command, Stdio},
    time::Instant,
};
struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn spawn(base: &std::path::Path, mode: &str, after: bool) -> Owned {
    Owned(
        Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "process::child"])
            .env_clear()
            .env("ORKESTR_V2_HOME", base)
            .env("MODE", mode)
            .env("AFTER", if after { "1" } else { "0" })
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
#[tokio::test]
#[ignore = "owned child entry invoked by parent"]
async fn child() {
    let base = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    if std::env::var("MODE").unwrap() == "reopen" {
        let root = PathBuf::from(load(&base, "root").as_str().unwrap());
        let expected: oracle::Rows = serde_json::from_value(load(&base, "killed")).unwrap();
        assert!(
            oracle::rows(&root).await == expected,
            "fresh exec readonly equality"
        );
        let s = Store::open(&root.join("core.sqlite3")).await.unwrap();
        assert!(oracle::rows(&root).await == expected, "open changed rows");
        let mut cfg = config();
        cfg.takeover = ProductionTakeover::ExpiredPredecessor {
            incarnation_id: load(&base, "predecessor").as_str().unwrap().into(),
        };
        assert!(matches!(
            s.authorize_supervisor(cases::TOKEN, cfg).await,
            Err(RuntimeStoreError::Busy)
        ));
        assert!(
            oracle::rows(&root).await == expected,
            "live predecessor refusal changed rows"
        );
        return;
    }
    let (c, mut h, p) = cases::active().await;
    save(&base, "root", json!(c.root));
    save(
        &base,
        "predecessor",
        json!(h.supervisor_incarnation().unwrap()),
    );
    save(&base, "before", json!(oracle::rows(&c.root).await));
    let after = std::env::var("AFTER").unwrap() == "1";
    h.production_arm_checkpoint(
        if after {
            ProductionCheckpoint::ObservationAfterCommit
        } else {
            ProductionCheckpoint::ObservationBeforeCommit
        },
        base.join("marker"),
    )
    .await
    .unwrap();
    let _ = h
        .append_provider_event(
            &c.owner,
            &p,
            &cases::event(
                &p,
                2,
                ProviderEvent::Progress("synthetic crash progress 😀".into()),
            ),
        )
        .await;
    panic!("checkpoint must wait for owned kill");
}
async fn wait_marker(child: &mut Owned, path: &std::path::Path) {
    let start = Instant::now();
    while !path.exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "child exited before marker"
        );
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "checkpoint timeout"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
#[tokio::test]
async fn progress_before_and_after_commit_kill_preserves_exact_ledger_and_payload() {
    use std::os::unix::process::ExitStatusExt;
    for after in [false, true] {
        let base = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&base).unwrap();
        let mut child = spawn(&base, "write", after);
        wait_marker(&mut child, &base.join("marker")).await;
        assert_eq!(
            std::fs::read_to_string(base.join("marker")).unwrap(),
            if after {
                "observation-after-commit"
            } else {
                "observation-before-commit"
            }
        );
        child.0.kill().unwrap();
        assert_eq!(child.0.wait().unwrap().signal(), Some(9));
        let root = PathBuf::from(load(&base, "root").as_str().unwrap());
        let before: oracle::Rows = serde_json::from_value(load(&base, "before")).unwrap();
        let killed = oracle::rows(&root).await;
        if !after {
            assert!(before == killed, "precommit partial rows");
        } else {
            let mut expected = before.clone();
            for table in [
                "events",
                "outbox",
                "production_observations",
                "production_payloads",
            ] {
                assert_eq!(killed[table].len(), before[table].len() + 1);
                assert!(
                    killed[table][..before[table].len()] == before[table],
                    "prior prefix changed"
                );
                expected.insert(table.into(), killed[table].clone());
            }
            let event = killed["events"].last().unwrap();
            let obs = killed["production_observations"].last().unwrap();
            let payload = killed["production_payloads"].last().unwrap();
            assert_eq!(event["schema_version"], 8);
            assert_eq!(event["kind"], "provider_observed");
            assert_eq!(
                event["sequence"].as_i64().unwrap(),
                before["conversations"][0]["sequence"].as_i64().unwrap() + 1
            );
            assert_eq!(obs["event_id"], event["id"]);
            assert_eq!(obs["kind"], "progress");
            assert_eq!(obs["run_sequence"], 2);
            assert_eq!(obs["receipt_state"], "running");
            assert_eq!(payload["event_id"], event["id"]);
            assert_eq!(payload["run_id"], obs["run_id"]);
            assert_eq!(payload["owner_id"], event["owner_id"]);
            assert_eq!(payload["conversation_id"], event["conversation_id"]);
            assert_eq!(payload["text"], "synthetic crash progress 😀");
            assert!(!Uuid::parse_str(payload["id"].as_str().unwrap())
                .unwrap()
                .is_nil());
            let run = &before["production_runs"][0];
            assert_eq!(obs["run_id"], run["id"]);
            assert_eq!(obs["lease_generation"], run["lease_generation"]);
            assert_eq!(obs["dispatch_fence"], run["dispatch_fence"]);
            let digest = obs["semantic_digest"].as_str().unwrap();
            assert!(digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()));
            assert_eq!(event["owner_id"], run["owner_id"]);
            assert_eq!(event["conversation_id"], run["conversation_id"]);
            assert!(event["message_id"].is_null());
            assert!(!Uuid::parse_str(event["id"].as_str().unwrap())
                .unwrap()
                .is_nil());
            assert!(!event["occurred_at"].as_str().unwrap().is_empty());
            assert_eq!(
                killed["outbox"].last().unwrap(),
                &json!({"event_id":event["id"],"state":"pending"})
            );
            // No state transition for progress; only conversation sequence and revision advance.
            for table in ["conversations", "execution_revisions"] {
                let field = if table == "conversations" {
                    "sequence"
                } else {
                    "revision"
                };
                let value = expected.get_mut(table).unwrap()[0][field].as_i64().unwrap() + 1;
                expected.get_mut(table).unwrap()[0][field] = json!(value);
            }
            assert!(expected == killed, "unexpected postcommit row change");
        }
        save(&base, "killed", json!(killed));
        let mut reopen = spawn(&base, "reopen", after);
        let start = Instant::now();
        loop {
            if let Some(status) = reopen.0.try_wait().unwrap() {
                assert!(status.success(), "fresh exec failed");
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(20));
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
