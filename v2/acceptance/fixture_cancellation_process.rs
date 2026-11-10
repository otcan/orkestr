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
            .args(["--ignored", "--exact", "independent_cancellation_child"])
            .env_clear()
            .env("ORKESTR_V2_HOME", root)
            .env("INDEPENDENT_CANCELLATION_PHASE", phase)
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
#[path = "independent_cancellation_process/snapshot.rs"]
mod snapshots;
use snapshots::{fingerprints, snapshot};

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
        "generation":p.binding.generation, "control":p.run.purpose == AdmissionPurpose::CancellationAcknowledgement, "predecessor":predecessor.to_string()})
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
            purpose: if v["control"].as_bool().unwrap() {
                AdmissionPurpose::CancellationAcknowledgement
            } else {
                AdmissionPurpose::Execution
            },
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
        namespace: "independent-cancellation".into(),
        supervisor_key: "owned-child".into(),
        takeover,
    }
}
#[tokio::test]
#[ignore = "owned child entry invoked by independent parent"]
async fn independent_cancellation_child() {
    let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    let phase = std::env::var("INDEPENDENT_CANCELLATION_PHASE").unwrap();
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

    let mut p = p;
    if phase.starts_with("stopped") {
        let receipt = handle
            .request_cancel(&owner, &p.run.run_id, "cancel")
            .await
            .unwrap();
        assert_eq!(receipt.state, RunState::CancelRequested);
        p.run = receipt.new_fenced_admission;
    }
    save(
        &root,
        "envelope.json",
        &envelope(&p, handle.incarnation_id()),
    );
    save(&root, "phase.json", &json!(phase));
    let baseline = snapshot(&root).await;
    save(&root, "baseline.json", &fingerprints(&baseline));
    save(
        &root,
        "expected.json",
        &snapshots::expected(&root, &baseline, &phase).await,
    );
    save(
        &root,
        "prefix.json",
        &fingerprints(&std::collections::BTreeMap::from([
            ("events".into(), baseline["events"].clone()),
            ("outbox".into(), baseline["outbox"].clone()),
            (
                "fixture_run_leases".into(),
                baseline["fixture_run_leases"].clone(),
            ),
        ])),
    );
    save(&root, "first-pid.json", &json!(std::process::id()));
    let point = match phase.as_str() {
        "cancel-before" => FixtureCheckpoint::CancelBeforeCommit,
        "cancel-after" => FixtureCheckpoint::CancelAfterCommit,
        "stopped-before" => FixtureCheckpoint::StoppedBeforeCommit,
        "stopped-after" => FixtureCheckpoint::StoppedAfterCommit,
        _ => panic!("phase"),
    };
    handle
        .fixture_arm_checkpoint(point, root.join("checkpoint"))
        .await
        .unwrap();
    if phase.starts_with("cancel") {
        let _ = handle.request_cancel(&owner, &p.run.run_id, "cancel").await;
    } else {
        let _ = handle
            .append_provider_event(&owner, &p, &input(&p, 1, ProviderEvent::Stopped))
            .await;
    }
    panic!("parent must kill before return");
}
async fn reopen(root: &Path, store: Store) {
    assert_ne!(load(root, "first-pid.json"), json!(std::process::id()));
    assert!(
        load(root, "killed.json") == fingerprints(&snapshot(root).await),
        "fresh open changed rows"
    );
    let value = load(root, "envelope.json");
    let p = decode(&value);
    let phase = load(root, "phase.json").as_str().unwrap().to_owned();
    let committed = phase.ends_with("after");
    let predecessor = Uuid::parse_str(value["predecessor"].as_str().unwrap()).unwrap();
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
    let next = loop {
        match bootstrap_fixture_supervisor(&store, &p.run.owner_id, take()).await {
            Ok(h) => break h,
            Err(RuntimeStoreError::Busy) => {
                assert!(Instant::now() < until);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            _ => panic!("takeover"),
        }
    };
    let before = snapshot(root).await;
    if phase.starts_with("cancel") {
        if committed {
            let a = next
                .request_cancel(&p.run.owner_id, &p.run.run_id, "cancel")
                .await
                .unwrap();
            let b = next
                .request_cancel(&p.run.owner_id, &p.run.run_id, "cancel")
                .await
                .unwrap();
            assert_eq!(a, b);
            assert_eq!(
                (a.state, a.inflight_status),
                (RunState::CancelRequested, InflightStatus::Unknown)
            );
            assert_eq!(
                a.new_fenced_admission.lease_generation,
                p.run.lease_generation + 1
            );
            assert_eq!(
                a.new_fenced_admission.dispatch_fence,
                p.run.dispatch_fence + 1
            );
            assert_eq!(
                json!(a.new_fenced_admission.lease_deadline_ms),
                load(root, "receipt-deadline.json")
            );
            assert_eq!(
                next.request_cancel(&p.run.owner_id, &p.run.run_id, "changed")
                    .await
                    .unwrap_err(),
                RuntimeStoreError::Fenced
            );
        } else {
            assert_eq!(
                next.request_cancel(&p.run.owner_id, &p.run.run_id, "cancel")
                    .await
                    .unwrap_err(),
                RuntimeStoreError::Fenced
            );
        }
        assert!(next
            .append_provider_event(&p.run.owner_id, &p, &input(&p, 1, ProviderEvent::Failed))
            .await
            .is_err());
    } else {
        let original = input(&p, 1, ProviderEvent::Stopped);
        if committed {
            let r = next
                .append_provider_event(&p.run.owner_id, &p, &original)
                .await
                .unwrap();
            assert!(r.duplicate);
            assert_eq!(
                (r.state, r.sequence, r.scope_sequence),
                (RunState::Cancelled, 1, 3)
            );
            assert_eq!(json!(r.event_id.to_string()), load(root, "event-id.json"));
            assert_eq!(
                next.append_provider_event(
                    &p.run.owner_id,
                    &p,
                    &input(&p, 1, ProviderEvent::Failed)
                )
                .await
                .unwrap_err(),
                RuntimeStoreError::Conflict
            );
        } else {
            assert_eq!(
                next.append_provider_event(&p.run.owner_id, &p, &original)
                    .await
                    .unwrap_err(),
                RuntimeStoreError::Fenced
            );
        }
        assert_eq!(
            next.append_provider_event(&p.run.owner_id, &p, &input(&p, 2, ProviderEvent::Stopped))
                .await
                .unwrap_err(),
            RuntimeStoreError::Fenced
        );
        // The request receipt stays immutable even after a committed Stopped acknowledgement.
        let request = next
            .request_cancel(&p.run.owner_id, &p.run.run_id, "cancel")
            .await
            .unwrap();
        assert_eq!(
            (request.state, request.inflight_status),
            (RunState::CancelRequested, InflightStatus::Unknown)
        );
    }
    assert!(
        before == snapshot(root).await,
        "replay/refusal changed rows"
    );
    let wire = serde_json::to_value(
        store
            .events(&p.run.owner_id, &p.run.conversation_id, 0, 100)
            .await
            .unwrap(),
    )
    .unwrap();
    let expected = if phase == "cancel-before" {
        vec![1]
    } else if phase == "stopped-after" {
        vec![1, 2, 3]
    } else {
        vec![1, 2]
    };
    assert_eq!(
        wire.as_array()
            .unwrap()
            .iter()
            .map(|e| e["sequence"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        expected
    );
    if expected.len() > 1 {
        assert_eq!(wire[1]["schema_version"], 3);
        assert_eq!(wire[1]["payload_ref_or_safe_payload"]["outcome"], "unknown");
    }
    if expected.len() == 3 {
        assert_eq!(wire[2]["schema_version"], 4);
        assert_eq!(
            wire[2]["payload_ref_or_safe_payload"]["receipt_state"],
            "cancelled"
        );
    }
    store.close().await;
    save(root, "finished.json", &json!(std::process::id()));
}
#[tokio::test]
async fn independent_cancel_stopped_sigkill_fresh_exec() {
    let root = Root(
        PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("independent-cancel-process-{}", Uuid::new_v4())),
    );
    std::fs::create_dir(&root.0).unwrap();
    let mut children = Vec::new();
    for phase in [
        "cancel-before",
        "cancel-after",
        "stopped-before",
        "stopped-after",
    ] {
        let case = root.0.join(phase);
        std::fs::create_dir(&case).unwrap();
        let mut child = spawn(&case, phase);
        let until = Instant::now() + Duration::from_secs(12);
        loop {
            if let Ok(marker) = std::fs::read(case.join("checkpoint")) {
                assert_eq!(marker, format!("{phase}-commit").as_bytes());
                break;
            }
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child exited before marker"
            );
            assert!(Instant::now() < until);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        child.0.kill().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(child.0.wait().unwrap().signal(), Some(9));
        let rows = snapshot(&case).await;
        if phase.ends_with("before") {
            assert!(
                load(&case, "baseline.json") == fingerprints(&rows),
                "partial precommit rows"
            );
        } else {
            snapshots::assert_commit(&case, &rows, phase).await;
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
                assert!(children[i].0.join("finished.json").exists());
                children.remove(i);
            } else {
                i += 1;
            }
        }
        assert!(Instant::now() < until);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
