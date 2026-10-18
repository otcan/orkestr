//! Owned-process loss, using public bootstrap only; no private handle recovery.
use super::observation_contract_tests::{consumed, input};
use super::*;
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::{ConversationId, RunId, SessionId};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn spawn(root: &Path, mode: &str) -> Owned {
    Owned(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "fixture_runtime::observation_process_tests::process_child",
                "--nocapture",
            ])
            .env_clear()
            .env("ORKESTR_V2_HOME", root)
            .env("OBSERVATION_PROCESS_MODE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    )
}
async fn wait_marker(child: &mut Owned, marker: &Path, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(bytes) = std::fs::read_to_string(marker) {
            assert_eq!(bytes, expected);
            return;
        }
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "child exited before checkpoint"
        );
        assert!(Instant::now() < deadline, "checkpoint timeout");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
async fn rows(path: &Path) -> Vec<String> {
    use sqlx::{
        sqlite::{SqliteConnectOptions, SqliteConnection},
        Connection,
    };
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path).read_only(true))
            .await
            .unwrap();
    let mut tx = connection.begin().await.unwrap();
    let mut result = Vec::new();
    for table in [
        "fixture_supervisors",
        "fixture_readiness",
        "fixture_runs",
        "fixture_observations",
        "reasoning_inbox",
        "session_bindings",
        "conversations",
        "events",
        "outbox",
        "fixture_run_leases",
    ] {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap()
            .iter()
            .map(|r| format!("\"{}\"", r.get::<String, _>("name")))
            .collect::<Vec<_>>()
            .join(",");
        result.push(sqlx::query_scalar(&format!("SELECT json_group_array(json_array({columns})) FROM (SELECT * FROM {table} ORDER BY rowid)")).fetch_one(&mut *tx).await.unwrap());
    }
    tx.commit().await.unwrap();
    connection.close().await.unwrap();
    result
}
fn artifact(p: &ProviderAdmission, incarnation: Uuid) -> Value {
    json!({"owner":p.run.owner_id.to_string(),"conversation":p.run.conversation_id.to_string(),"run":p.run.run_id.to_string(),"session":p.run.session_id.to_string(),"native":p.run.native_session_id,"lease":p.run.lease_generation,"fence":p.run.dispatch_fence,"deadline":p.run.lease_deadline_ms,"binding_generation":p.binding.generation,"predecessor":incarnation.to_string()})
}
fn provider(v: &Value) -> ProviderAdmission {
    let id = |k: &str| Uuid::parse_str(v[k].as_str().unwrap()).unwrap();
    let owner = OwnerId(id("owner"));
    let conversation = ConversationId(id("conversation"));
    let session = SessionId(id("session"));
    let native = Some(v["native"].as_str().unwrap().to_owned());
    ProviderAdmission {
        run: RunAdmission {
            owner_id: owner.clone(),
            conversation_id: conversation.clone(),
            run_id: RunId(id("run")),
            session_id: session.clone(),
            role: Role::Deep,
            native_session_id: native.clone(),
            lease_generation: v["lease"].as_u64().unwrap(),
            dispatch_fence: v["fence"].as_u64().unwrap(),
            attempt: 1,
            lease_deadline_ms: v["deadline"].as_i64().unwrap(),
            purpose: AdmissionPurpose::Execution,
        },
        binding: Binding {
            owner_id: owner,
            conversation_id: conversation,
            session_id: session,
            role: Role::Deep,
            provider_kind: ProviderKind::ExplicitFixture,
            native_session_id: native,
            parent_session_id: None,
            generation: v["binding_generation"].as_u64().unwrap(),
            state: SessionState::Ready,
        },
    }
}
#[tokio::test]
#[ignore = "owned child entry; invoked by process parent"]
async fn process_child() {
    let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    let mode = std::env::var("OBSERVATION_PROCESS_MODE").unwrap();
    if mode != "reopen" {
        let mut f = super::dispatch_tests::fixture().await;
        let p = consumed(&f).await;
        // Synthetic envelope only. No context ID, candidate, reservation or verifier.
        std::fs::write(
            root.join("envelope.json"),
            serde_json::to_vec(&artifact(&p, f.handle.incarnation_id())).unwrap(),
        )
        .unwrap();
        std::fs::write(root.join("database"), f.root.to_str().unwrap()).unwrap();
        let before = rows(&f.root.join("core.sqlite3")).await;
        std::fs::write(
            root.join("before.json"),
            serde_json::to_vec(&before).unwrap(),
        )
        .unwrap();
        let stage = if mode == "before" {
            test_controls::FixtureCheckpoint::ObservationBeforeCommit
        } else {
            test_controls::FixtureCheckpoint::ObservationAfterCommit
        };
        f.handle
            .fixture_arm_checkpoint(stage, root.join("checkpoint"))
            .await
            .unwrap();
        let _ = f
            .handle
            .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
            .await;
        panic!("parent must kill before reply");
    }
    let database =
        PathBuf::from(std::fs::read_to_string(root.join("database")).unwrap()).join("core.sqlite3");
    let v: Value =
        serde_json::from_slice(&std::fs::read(root.join("envelope.json")).unwrap()).unwrap();
    let p = provider(&v);
    let event = input(&p, 1, ProviderEvent::Started);
    let store = Store::open(&database).await.unwrap();
    let killed: Vec<String> =
        serde_json::from_slice(&std::fs::read(root.join("killed.json")).unwrap()).unwrap();
    assert!(
        killed == rows(&database).await,
        "new process changed crash snapshot"
    );
    assert_eq!(
        store
            .append_provider_event(&p.run.owner_id, &p, &event)
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    let config = || ExplicitFixtureSupervisorConfig {
        namespace: "explicit-fixture".into(),
        supervisor_key: "fixture-worker".into(),
        takeover: FixtureTakeover::ExpiredPredecessor {
            incarnation_id: Uuid::parse_str(v["predecessor"].as_str().unwrap()).unwrap(),
        },
    };
    assert!(matches!(
        bootstrap_fixture_supervisor(&store, &p.run.owner_id, config()).await,
        Err(RuntimeStoreError::Busy)
    ));
    let deadline = Instant::now() + Duration::from_secs(70);
    let handle = loop {
        match bootstrap_fixture_supervisor(&store, &p.run.owner_id, config()).await {
            Ok(h) => break h,
            Err(RuntimeStoreError::Busy) => {
                assert!(Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => panic!("unexpected takeover: {e:?}"),
        }
    };
    let before = rows(&database).await;
    let committed = root.join("committed").exists();
    if committed {
        let receipt = handle
            .append_provider_event(&p.run.owner_id, &p, &event)
            .await
            .unwrap();
        assert!(receipt.duplicate);
        assert_eq!(receipt.state, RunState::Running);
        assert_eq!(receipt.sequence, 1);
        let event_id: String = sqlx::query_scalar("SELECT event_id FROM fixture_observations")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(receipt.event_id.to_string(), event_id);
        let sequence: i64 = sqlx::query_scalar("SELECT sequence FROM events WHERE id=?")
            .bind(event_id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(receipt.scope_sequence, sequence);
        assert_eq!(
            handle
                .append_provider_event(&p.run.owner_id, &p, &input(&p, 1, ProviderEvent::Failed))
                .await
                .unwrap_err(),
            RuntimeStoreError::Conflict
        );
    } else {
        assert_eq!(
            handle
                .append_provider_event(&p.run.owner_id, &p, &event)
                .await
                .unwrap_err(),
            RuntimeStoreError::Fenced
        );
    }
    assert_eq!(
        handle
            .append_provider_event(&p.run.owner_id, &p, &input(&p, 2, ProviderEvent::Failed))
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert!(
        before == rows(&database).await,
        "replay/refusal changed durable rows"
    );
    store.close().await;
}
#[tokio::test]
async fn sigkill_observation_rollback_and_committed_lost_reply_new_process() {
    let base = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("observation-process-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let mut reopen = Vec::new();
    for mode in ["before", "after"] {
        let root = base.join(mode);
        std::fs::create_dir(&root).unwrap();
        let mut child = spawn(&root, mode);
        wait_marker(
            &mut child,
            &root.join("checkpoint"),
            if mode == "before" {
                "observation-before-commit"
            } else {
                "observation-after-commit"
            },
        )
        .await;
        child.0.kill().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(child.0.wait().unwrap().signal(), Some(9));
        let db = PathBuf::from(std::fs::read_to_string(root.join("database")).unwrap())
            .join("core.sqlite3");
        let before: Vec<String> =
            serde_json::from_slice(&std::fs::read(root.join("before.json")).unwrap()).unwrap();
        let after = rows(&db).await;
        if mode == "before" {
            assert!(before == after, "precommit crash changed rows");
        } else {
            assert!(before != after);
            for index in [7, 8] {
                let old: Value = serde_json::from_str(&before[index]).unwrap();
                let new: Value = serde_json::from_str(&after[index]).unwrap();
                assert_eq!(
                    new.as_array().unwrap().len(),
                    old.as_array().unwrap().len() + 1
                );
                assert_eq!(
                    &new.as_array().unwrap()[..old.as_array().unwrap().len()],
                    old.as_array().unwrap()
                );
            }
            for (index, projection) in [(2, "run"), (6, "conversation")] {
                let old: Value = serde_json::from_str(&before[index]).unwrap();
                let new: Value = serde_json::from_str(&after[index]).unwrap();
                let old = old[0].as_array().unwrap();
                let new = new[0].as_array().unwrap();
                let changes = old
                    .iter()
                    .zip(new)
                    .filter(|(a, b)| a != b)
                    .collect::<Vec<_>>();
                assert_eq!(
                    changes.len(),
                    1,
                    "unexpected projection delta: {projection}"
                );
                if projection == "run" {
                    assert_eq!(changes[0], (&json!("starting"), &json!("running")));
                } else {
                    assert_eq!(
                        changes[0].1.as_i64().unwrap(),
                        changes[0].0.as_i64().unwrap() + 1
                    );
                }
            }
            let observations: Value = serde_json::from_str(&after[3]).unwrap();
            assert_eq!(observations.as_array().unwrap().len(), 1);
            for index in [0, 1, 4, 5, 9] {
                assert!(before[index] == after[index]);
            }
            std::fs::write(root.join("committed"), b"yes").unwrap();
        }
        std::fs::write(
            root.join("killed.json"),
            serde_json::to_vec(&after).unwrap(),
        )
        .unwrap();
        reopen.push((spawn(&root, "reopen"), db.parent().unwrap().to_path_buf()));
    }
    let deadline = Instant::now() + Duration::from_secs(80);
    while !reopen.is_empty() {
        let mut i = 0;
        while i < reopen.len() {
            if let Some(status) = reopen[i].0 .0.try_wait().unwrap() {
                assert!(status.success());
                let (_, path) = reopen.remove(i);
                std::fs::remove_dir_all(path).unwrap();
            } else {
                i += 1;
            }
        }
        assert!(Instant::now() < deadline, "fresh process deadline");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    std::fs::remove_dir_all(base).unwrap();
}
