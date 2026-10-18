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
#[ignore = "owned child entry invoked by independent parent"]
async fn child() {
    use orkestr_v2_contracts::ExecutionAcceptanceRequest;
    let base = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    if std::env::var("MODE").unwrap() == "reopen" {
        let root = PathBuf::from(load(&base, "root").as_str().unwrap());
        let killed: oracle::Rows = serde_json::from_value(load(&base, "killed")).unwrap();
        assert!(
            oracle::rows(&root).await == killed,
            "fresh exec pre-open ledger changed"
        );
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        assert!(
            oracle::rows(&root).await == killed,
            "open mutated execution rows"
        );
        let owner = store.authenticate(TOKEN).await.unwrap().unwrap();
        let conversation: ConversationId =
            serde_json::from_value(load(&base, "conversation")).unwrap();
        let request: ExecutionAcceptanceRequest =
            serde_json::from_value(load(&base, "request")).unwrap();
        let receipt = store
            .accept_execution(&owner, &conversation, &request)
            .await
            .unwrap();
        assert!(receipt.is_valid());
        let committed = oracle::rows(&root).await;
        let before: oracle::Rows = serde_json::from_value(load(&base, "before")).unwrap();
        exact_delta(&before, &committed, &request);
        if std::env::var("AFTER").unwrap() == "1" {
            assert!(
                committed == killed,
                "lost receipt retry mutated durable rows"
            );
        }
        assert_eq!(
            receipt.acceptance_event_id.to_string(),
            committed["production_acceptances"][0]["event_id"]
                .as_str()
                .unwrap()
        );
        assert_eq!(
            store
                .accept_execution(&owner, &conversation, &request)
                .await
                .unwrap(),
            receipt
        );
        let mut changed = request.clone();
        changed.expected_revision += 1;
        assert!(matches!(
            store
                .accept_execution(&owner, &conversation, &changed)
                .await,
            Err(RuntimeStoreError::Conflict)
        ));
        let foreign = OwnerId(Uuid::new_v4());
        assert!(store
            .accept_execution(&foreign, &conversation, &request)
            .await
            .is_err());
        assert!(
            oracle::rows(&root).await == committed,
            "replay/refusal altered committed rows"
        );
        save(&base, "done", json!(true));
        return;
    }
    let (mut c, _h, _p, request) = acceptance::proposal().await;
    save(&base, "root", json!(c.root));
    save(&base, "conversation", json!(c.conversation));
    save(&base, "request", json!(request));
    save(&base, "before", json!(oracle::rows(&c.root).await));
    let after = std::env::var("AFTER").unwrap() == "1";
    c.store
        .production_arm_owner_checkpoint(
            &c.owner,
            &c.conversation,
            if after {
                ProductionCheckpoint::AcceptanceAfterCommit
            } else {
                ProductionCheckpoint::AcceptanceBeforeCommit
            },
            base.join("marker"),
        )
        .await
        .unwrap();
    let _ = c
        .store
        .accept_execution(&c.owner, &c.conversation, &request)
        .await;
    panic!("checkpoint writer must wait for owned SIGKILL");
}
fn exact_delta(
    before: &oracle::Rows,
    after: &oracle::Rows,
    request: &orkestr_v2_contracts::ExecutionAcceptanceRequest,
) {
    let mut expected = before.clone();
    for table in ["events", "outbox", "production_acceptances"] {
        assert_eq!(after[table].len(), before[table].len() + 1);
        assert!(
            after[table][..before[table].len()] == before[table],
            "prior prefix changed"
        );
        expected.insert(table.into(), after[table].clone());
    }
    let event = after["events"].last().unwrap();
    let decision = after["production_acceptances"].last().unwrap();
    let run = &before["production_runs"][0];
    assert_eq!(event["kind"], "execution_accepted");
    assert_eq!(event["schema_version"], 9);
    assert!(event["message_id"].is_null());
    assert_eq!(event["owner_id"], run["owner_id"]);
    assert_eq!(event["conversation_id"], run["conversation_id"]);
    assert!(!Uuid::parse_str(event["id"].as_str().unwrap())
        .unwrap()
        .is_nil());
    assert!(!event["occurred_at"].as_str().unwrap().is_empty());
    let sequence = before["conversations"][0]["sequence"].as_i64().unwrap() + 1;
    let revision = before["execution_revisions"][0]["revision"]
        .as_i64()
        .unwrap()
        + 1;
    assert_eq!(event["sequence"], sequence);
    assert_eq!(
        decision,
        &json!({"run_id":run["id"],"owner_id":run["owner_id"],"conversation_id":run["conversation_id"],"completion_event_id":request.completion_event_id,"event_id":event["id"],"request_key":request.request_key,"requested_revision":request.expected_revision,"receipt_revision":revision})
    );
    assert_eq!(
        after["outbox"].last().unwrap(),
        &json!({"event_id":event["id"],"state":"pending"})
    );
    expected.get_mut("production_runs").unwrap()[0]["state"] = json!("succeeded");
    let bindings = expected.get_mut("session_bindings").unwrap();
    let binding = bindings
        .iter_mut()
        .find(|b| b["id"] == run["session_id"])
        .unwrap();
    assert_eq!(binding["state"], "busy");
    let generation = binding["generation"].as_i64().unwrap();
    binding["state"] = json!("ready");
    binding["generation"] = json!(generation + 1);
    expected.get_mut("conversations").unwrap()[0]["sequence"] = json!(sequence);
    expected.get_mut("execution_revisions").unwrap()[0]["revision"] = json!(revision);
    assert!(
        expected == *after,
        "unexpected committed row/column mutation"
    );
}
async fn wait_marker(child: &mut Owned, path: &std::path::Path) {
    let start = Instant::now();
    while !path.exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "writer exited before checkpoint"
        );
        assert!(start.elapsed() < Duration::from_secs(20));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
#[tokio::test]
async fn owner_decision_sigkill_before_and_after_commit_then_new_exec_exact_retry() {
    use std::os::unix::process::ExitStatusExt;
    for after in [false, true] {
        let base = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&base).unwrap();
        let mut writer = spawn(&base, "write", after);
        wait_marker(&mut writer, &base.join("marker")).await;
        assert_eq!(
            std::fs::read_to_string(base.join("marker")).unwrap(),
            if after {
                "acceptance-after-commit"
            } else {
                "acceptance-before-commit"
            }
        );
        writer.0.kill().unwrap();
        assert_eq!(writer.0.wait().unwrap().signal(), Some(9));
        let root = PathBuf::from(load(&base, "root").as_str().unwrap());
        let before: oracle::Rows = serde_json::from_value(load(&base, "before")).unwrap();
        let killed = oracle::rows(&root).await;
        if after {
            exact_delta(
                &before,
                &killed,
                &serde_json::from_value(load(&base, "request")).unwrap(),
            );
        } else {
            assert!(before == killed, "uncommitted partial owner decision");
        }
        save(&base, "killed", json!(killed));
        let mut reopen = spawn(&base, "reopen", after);
        let start = Instant::now();
        loop {
            if let Some(status) = reopen.0.try_wait().unwrap() {
                assert!(status.success(), "fresh exec retry failed");
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(20));
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(load(&base, "done"), json!(true));
    }
}
