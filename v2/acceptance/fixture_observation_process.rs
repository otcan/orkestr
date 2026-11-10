//! Independent SIGKILL observations: public fixture authority, fresh exec takeover.
#![cfg(all(feature = "fixture-test-controls", unix))]
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ConversationId, MessageInput, OwnerId, RunId, SessionId};
use orkestr_v2_store_sqlite::{
    fixture_runtime::{test_controls::FixtureCheckpoint, *},
    Store,
};
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use uuid::Uuid;

struct Owned(Child);
impl Drop for Owned {
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
fn spawn(root: &Path, phase: &str) -> Owned {
    Owned(
        Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "independent_observation_child"])
            .env_clear()
            .env("ORKESTR_V2_HOME", root)
            .env("INDEPENDENT_OBSERVATION_PHASE", phase)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    )
}
fn save(root: &Path, name: &str, value: &Value) {
    std::fs::write(root.join(name), serde_json::to_vec(value).unwrap()).unwrap();
}
fn load(root: &Path, name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(root.join(name)).unwrap()).unwrap()
}
#[path = "independent_observation_process/snapshot.rs"]
mod snapshots;
use snapshots::{expected_projections, fingerprints, snapshot};

fn input(p: &ProviderAdmission, sequence: u64, event: ProviderEvent) -> ProviderEventInput {
    ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        sequence,
        event,
    }
}
fn envelope(p: &ProviderAdmission, predecessor: Uuid) -> Value {
    json!({"owner":p.run.owner_id.to_string(), "conversation":p.run.conversation_id.to_string(),
        "run":p.run.run_id.to_string(), "session":p.run.session_id.to_string(),
        "native":p.run.native_session_id, "lease":p.run.lease_generation,
        "fence":p.run.dispatch_fence, "deadline":p.run.lease_deadline_ms,
        "generation":p.binding.generation, "predecessor":predecessor.to_string()})
}
// Decode only the immutable synthetic provider envelope, never a private handle,
// context identifier, candidate/reservation verifier or attachment capability.
fn decode(v: &Value) -> ProviderAdmission {
    let id = |key: &str| Uuid::parse_str(v[key].as_str().unwrap()).unwrap();
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
            generation: v["generation"].as_u64().unwrap(),
            state: SessionState::Ready,
        },
    }
}
fn config(takeover: FixtureTakeover) -> ExplicitFixtureSupervisorConfig {
    ExplicitFixtureSupervisorConfig {
        namespace: "independent-observation".into(),
        supervisor_key: "owned-child".into(),
        takeover,
    }
}
#[tokio::test]
#[ignore = "owned child entry invoked by independent parent"]
async fn independent_observation_child() {
    let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("owned root"));
    let phase = std::env::var("INDEPENDENT_OBSERVATION_PHASE").unwrap();
    let store = Store::open(&root.join("case.sqlite3")).await.unwrap();
    if phase == "reopen" {
        reopen(&root, store).await;
        return;
    }
    let conversation = store.setup("synthetic", "synthetic-hash").await.unwrap();
    let owner = store.credentials("synthetic").await.unwrap().unwrap().0;
    let mut handle = bootstrap_fixture_supervisor(&store, &owner, config(FixtureTakeover::First))
        .await
        .unwrap();
    let roles = store
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap();
    let binding = handle
        .confirm_fixture_readiness(&roles.deep.session_id, 1)
        .await
        .unwrap();
    store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "synthetic-input".into(),
                text: "Independent observation crash".into(),
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
    let admitted = handle
        .admit_run(&claim, &binding.session_id, binding.generation, "run")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = handle
        .claim_provider_dispatch(&admitted, "dispatch")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    assert_eq!(
        handle
            .consume_provider_dispatch(&reservation)
            .await
            .unwrap(),
        DispatchConsumption::DispatchNow
    );
    let p = reservation.provider;
    save(
        &root,
        "envelope.json",
        &envelope(&p, handle.incarnation_id()),
    );
    let baseline = snapshot(&root).await;
    save(&root, "baseline.json", &fingerprints(&baseline));
    save(
        &root,
        "expected-projections.json",
        &expected_projections(&root, &baseline).await,
    );
    save(
        &root,
        "prefix.json",
        &fingerprints(&[baseline[1].clone(), baseline[2].clone()]),
    );
    save(&root, "first-pid.json", &json!(std::process::id()));
    let point = match phase.as_str() {
        "before" => FixtureCheckpoint::ObservationBeforeCommit,
        "after" => FixtureCheckpoint::ObservationAfterCommit,
        _ => panic!("phase"),
    };
    handle
        .fixture_arm_checkpoint(point, root.join("checkpoint"))
        .await
        .unwrap();
    let _ = handle
        .append_provider_event(&owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await;
    panic!("parent must kill before reply");
}
async fn reopen(root: &Path, store: Store) {
    assert_ne!(load(root, "first-pid.json"), json!(std::process::id()));
    assert!(
        load(root, "killed.json") == fingerprints(&snapshot(root).await),
        "open mutated snapshot"
    );
    let v = load(root, "envelope.json");
    let p = decode(&v);
    assert_eq!(
        store.credentials("synthetic").await.unwrap().unwrap().0,
        p.run.owner_id
    );
    let original = input(&p, 1, ProviderEvent::Started);
    assert_eq!(
        store
            .append_provider_event(&p.run.owner_id, &p, &original)
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    let predecessor = Uuid::parse_str(v["predecessor"].as_str().unwrap()).unwrap();
    let take = || {
        config(FixtureTakeover::ExpiredPredecessor {
            incarnation_id: predecessor,
        })
    };
    assert!(matches!(
        bootstrap_fixture_supervisor(&store, &p.run.owner_id, take()).await,
        Err(RuntimeStoreError::Busy)
    ));
    let until = Instant::now() + Duration::from_secs(70);
    let successor = loop {
        match bootstrap_fixture_supervisor(&store, &p.run.owner_id, take()).await {
            Ok(h) => break h,
            Err(RuntimeStoreError::Busy) => {
                assert!(Instant::now() < until, "takeover deadline");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(_) => panic!("unexpected takeover refusal"),
        }
    };
    let before = snapshot(root).await;
    let committed = root.join("committed").exists();
    if committed {
        let receipt = successor
            .append_provider_event(&p.run.owner_id, &p, &original)
            .await
            .unwrap();
        assert!(receipt.duplicate);
        assert_eq!(receipt.state, RunState::Running);
        assert_eq!((receipt.sequence, receipt.scope_sequence), (1, 2));
        assert_eq!(
            json!(receipt.event_id.to_string()),
            load(root, "event-id.json")
        );
        for changed in [
            ProviderEvent::Failed,
            ProviderEvent::Stopped,
            ProviderEvent::Progress("changed".into()),
        ] {
            assert_eq!(
                successor
                    .append_provider_event(&p.run.owner_id, &p, &input(&p, 1, changed))
                    .await
                    .unwrap_err(),
                RuntimeStoreError::Conflict
            );
        }
    } else {
        assert_eq!(
            successor
                .append_provider_event(&p.run.owner_id, &p, &original)
                .await
                .unwrap_err(),
            RuntimeStoreError::Fenced
        );
    }
    assert_eq!(
        successor
            .append_provider_event(&p.run.owner_id, &p, &input(&p, 2, ProviderEvent::Failed))
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert!(
        before == snapshot(root).await,
        "replay/refusal mutated durable rows"
    );
    let events = store
        .events(&p.run.owner_id, &p.run.conversation_id, 0, 100)
        .await
        .unwrap();
    let canonical = serde_json::to_value(events).unwrap();
    let sequences = canonical
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["sequence"].as_i64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(sequences, if committed { vec![1, 2] } else { vec![1] });
    store.close().await;
    save(
        root,
        "finished.json",
        &json!({"pid":std::process::id(),"committed":committed}),
    );
}
#[tokio::test]
async fn independent_observation_sigkill_and_fresh_process_takeover() {
    let root = Root(
        PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home")).join(format!(
            "independent-observation-process-{}",
            Uuid::new_v4()
        )),
    );
    std::fs::create_dir(&root.0).unwrap();
    let mut children = Vec::new();
    for phase in ["before", "after"] {
        let case = root.0.join(phase);
        std::fs::create_dir(&case).unwrap();
        let mut child = spawn(&case, phase);
        let until = Instant::now() + Duration::from_secs(12);
        loop {
            if let Ok(marker) = std::fs::read(case.join("checkpoint")) {
                assert_eq!(marker, format!("observation-{phase}-commit").as_bytes());
                break;
            }
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child exited before checkpoint"
            );
            assert!(Instant::now() < until, "checkpoint timeout");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        child.0.kill().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(child.0.wait().unwrap().signal(), Some(9));
        let rows = snapshot(&case).await;
        if phase == "before" {
            assert!(
                load(&case, "baseline.json") == fingerprints(&rows),
                "partial precommit writes"
            );
        } else {
            let old = load(&case, "baseline.json");
            let hashes = fingerprints(&rows);
            for index in [5, 6, 7, 8] {
                assert!(old[index] == hashes[index], "unrelated table changed");
            }
            let projections = load(&case, "expected-projections.json");
            for index in [0, 4] {
                assert!(
                    projections[index] == hashes[index],
                    "unexpected projection change"
                );
            }
            assert!(
                load(&case, "prefix.json")
                    == fingerprints(&[rows[1][..1].to_vec(), rows[2][..1].to_vec()]),
                "prior event/outbox mutated"
            );
            assert_eq!(
                (
                    rows[0].len(),
                    rows[1].len(),
                    rows[2].len(),
                    rows[3].len(),
                    rows[4].len()
                ),
                (1, 2, 2, 1, 1)
            );
            // Public event ID and canonical sequence are read in a separate read-only
            // connection only after the complete transaction snapshot above.
            let mut db = SqliteConnection::connect_with(
                &SqliteConnectOptions::new()
                    .filename(case.join("case.sqlite3"))
                    .read_only(true),
            )
            .await
            .unwrap();
            sqlx::query("PRAGMA query_only=ON")
                .execute(&mut db)
                .await
                .unwrap();
            let id: String = sqlx::query_scalar(
                "SELECT event_id FROM fixture_observations WHERE run_sequence=1",
            )
            .fetch_one(&mut db)
            .await
            .unwrap();
            save(&case, "event-id.json", &json!(id));
            db.close().await.unwrap();
            std::fs::write(case.join("committed"), b"yes").unwrap();
        }
        save(&case, "killed.json", &fingerprints(&rows));
        children.push((case.clone(), spawn(&case, "reopen")));
    }
    let until = Instant::now() + Duration::from_secs(80);
    while !children.is_empty() {
        let mut i = 0;
        while i < children.len() {
            if let Some(status) = children[i].1 .0.try_wait().unwrap() {
                assert!(status.success(), "fresh process failed");
                assert!(children[i].0.join("finished.json").is_file());
                children.remove(i);
            } else {
                i += 1;
            }
        }
        assert!(Instant::now() < until, "fresh exec timeout");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
