//! Registry metadata tests only. Synthetic receipts here are not execution
//! authority; actual authenticated cancellation/native I/O is exercised by HTTP.
#[path = "../src/control_dispatch.rs"]
#[allow(dead_code)]
mod control_dispatch;
#[path = "../src/control_registry.rs"]
#[allow(dead_code)]
mod control_registry;
#[path = "../src/stop_execution/mod.rs"]
#[allow(dead_code)]
mod stop_execution;

use control_dispatch::HandoffError;
use control_registry::{ControlRegistry, RegistryError};
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::{ConversationId, ExecutionControlRequest, OwnerId, RunId, SessionId};
use orkestr_v2_store_sqlite::Store;
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;

struct Case {
    root: PathBuf,
    store: Store,
    registry: ControlRegistry,
    owner: OwnerId,
    conversation: ConversationId,
}
impl Case {
    async fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"))
            .join(format!("control-registry-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let owner = OwnerId(Uuid::new_v4());
        let conversation = ConversationId(Uuid::new_v4());
        let registry = ControlRegistry::new(owner.clone(), conversation.clone());
        Self {
            root,
            store,
            registry,
            owner,
            conversation,
        }
    }
    fn receipt(&self, run: &RunId) -> CancelReceipt {
        CancelReceipt {
            new_fenced_admission: RunAdmission {
                owner_id: self.owner.clone(),
                conversation_id: self.conversation.clone(),
                run_id: run.clone(),
                session_id: SessionId(Uuid::new_v4()),
                role: Role::Worker,
                native_session_id: Some("synthetic-registry-metadata".into()),
                lease_generation: 2,
                dispatch_fence: 2,
                attempt: 1,
                lease_deadline_ms: 100,
                purpose: AdmissionPurpose::CancellationAcknowledgement,
            },
            state: RunState::CancelRequested,
            inflight_status: InflightStatus::Unknown,
        }
    }
    async fn close(self) {
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}
fn input(run: &RunId) -> ExecutionControlRequest {
    ExecutionControlRequest {
        run_id: run.clone(),
        expected_revision: 1,
        request_key: "synthetic-stop".into(),
    }
}

#[tokio::test]
async fn exact_scope_and_receipt_are_required_before_handoff() {
    let f = Case::new().await;
    let run = RunId(Uuid::new_v4());
    let (control, mut receiver) = f.registry.register(f.store.clone(), &run).unwrap();
    assert!(f
        .registry
        .request(&f.owner, &f.conversation, &input(&run))
        .is_none());
    control.set_available(true);
    assert!(f
        .registry
        .request(&OwnerId(Uuid::new_v4()), &f.conversation, &input(&run))
        .is_none());
    assert!(f
        .registry
        .request(&f.owner, &ConversationId(Uuid::new_v4()), &input(&run))
        .is_none());
    assert!(f
        .registry
        .request(&f.owner, &f.conversation, &input(&RunId(Uuid::new_v4())))
        .is_none());
    let request = f
        .registry
        .request(&f.owner, &f.conversation, &input(&run))
        .unwrap();
    let mut wrong = f.receipt(&run);
    wrong.new_fenced_admission.run_id = RunId(Uuid::new_v4());
    assert_eq!(
        request.publish(wrong),
        Err(RegistryError::Handoff(HandoffError::WrongScope))
    );
    assert!(receiver.take().unwrap().is_none());
    assert!(request.is_permitted());
    request.publish(f.receipt(&run)).unwrap();
    assert!(receiver.take().unwrap().is_some());
    assert!(!f.registry.available(&f.owner, &f.conversation, &run));
    drop((control, receiver));
    f.close().await;
}

#[tokio::test]
async fn closed_run_replays_only_the_original_request_and_receipt_without_delivery() {
    let f = Case::new().await;
    let run = RunId(Uuid::new_v4());
    let (control, mut receiver) = f.registry.register(f.store.clone(), &run).unwrap();
    control.set_available(true);
    let request = f
        .registry
        .request(&f.owner, &f.conversation, &input(&run))
        .unwrap();
    let receipt = f.receipt(&run);
    request.publish(receipt.clone()).unwrap();
    assert!(receiver.take().unwrap().is_some());
    request.publish(receipt.clone()).unwrap();
    assert!(receiver.take().unwrap().is_none());
    drop((control, receiver));
    let replay = f
        .registry
        .request(&f.owner, &f.conversation, &input(&run))
        .unwrap();
    replay.publish(receipt.clone()).unwrap();
    for field in 0..2 {
        let mut changed = input(&run);
        if field == 0 {
            changed.expected_revision += 1;
        } else {
            changed.request_key.push('x');
        }
        assert!(f
            .registry
            .request(&f.owner, &f.conversation, &changed)
            .is_none());
    }
    let mut changed = receipt;
    changed.new_fenced_admission.dispatch_fence += 1;
    assert_eq!(
        replay.publish(changed),
        Err(RegistryError::Handoff(HandoffError::Conflict))
    );
    f.close().await;
}

#[tokio::test]
async fn cleanup_while_request_waits_denies_fresh_publication() {
    let f = Case::new().await;
    let run = RunId(Uuid::new_v4());
    let (control, mut receiver) = f.registry.register(f.store.clone(), &run).unwrap();
    control.set_available(true);
    let step = control.serialize().await;
    let request = f
        .registry
        .request(&f.owner, &f.conversation, &input(&run))
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), request.serialize())
            .await
            .is_err()
    );
    drop(control);
    drop(step);
    let _step = request.serialize().await;
    assert!(!request.is_permitted());
    assert_eq!(request.publish(f.receipt(&run)), Err(RegistryError::Closed));
    assert!(receiver.take().unwrap().is_none());
    drop(receiver);
    f.close().await;
}

#[tokio::test]
async fn different_runs_have_independent_step_locks_and_mailboxes() {
    let f = Case::new().await;
    let parent = RunId(Uuid::new_v4());
    let child = RunId(Uuid::new_v4());
    let (deep, mut deep_receiver) = f.registry.register(f.store.clone(), &parent).unwrap();
    let (worker, mut worker_receiver) = f.registry.register(f.store.clone(), &child).unwrap();
    deep.set_available(true);
    worker.set_available(true);
    let deep_step = deep.serialize().await;
    let request = f
        .registry
        .request(&f.owner, &f.conversation, &input(&child))
        .unwrap();
    let worker_step = tokio::time::timeout(Duration::from_millis(100), request.serialize())
        .await
        .unwrap();
    request.publish(f.receipt(&child)).unwrap();
    assert!(worker_receiver.take().unwrap().is_some());
    assert!(deep_receiver.take().unwrap().is_none());
    assert!(f.registry.available(&f.owner, &f.conversation, &parent));
    drop((
        deep_step,
        worker_step,
        deep,
        worker,
        deep_receiver,
        worker_receiver,
    ));
    f.close().await;
}

#[tokio::test]
async fn active_capacity_refuses_without_evicting_owned_runs() {
    let f = Case::new().await;
    let mut registrations = Vec::new();
    for _ in 0..16 {
        let run = RunId(Uuid::new_v4());
        let (control, receiver) = f.registry.register(f.store.clone(), &run).unwrap();
        control.set_available(true);
        registrations.push((run, control, receiver));
    }
    let extra = RunId(Uuid::new_v4());
    assert!(matches!(
        f.registry.register(f.store.clone(), &extra),
        Err(RegistryError::Capacity)
    ));
    assert!(matches!(
        f.registry.register(f.store.clone(), &registrations[0].0),
        Err(RegistryError::Conflict)
    ));
    assert!(f
        .registry
        .available(&f.owner, &f.conversation, &registrations[0].0));
    drop(registrations.pop());
    let extra = f.registry.register(f.store.clone(), &extra).unwrap();
    drop((extra, registrations));
    f.close().await;
}

#[tokio::test]
async fn bounded_retired_replay_evicts_oldest_closed_entry_only() {
    let f = Case::new().await;
    let active_id = RunId(Uuid::new_v4());
    let (active, active_receiver) = f.registry.register(f.store.clone(), &active_id).unwrap();
    active.set_available(true);
    let mut history = Vec::new();
    for _ in 0..65 {
        let run = RunId(Uuid::new_v4());
        let (control, receiver) = f.registry.register(f.store.clone(), &run).unwrap();
        control.set_available(true);
        let request = f
            .registry
            .request(&f.owner, &f.conversation, &input(&run))
            .unwrap();
        let receipt = f.receipt(&run);
        request.publish(receipt.clone()).unwrap();
        history.push((run, receipt));
        drop((control, receiver));
    }
    assert!(f
        .registry
        .request(&f.owner, &f.conversation, &input(&history[0].0))
        .is_none());
    for (run, receipt) in &history[1..] {
        f.registry
            .request(&f.owner, &f.conversation, &input(run))
            .unwrap()
            .publish(receipt.clone())
            .unwrap();
    }
    assert!(f.registry.available(&f.owner, &f.conversation, &active_id));
    drop((active, active_receiver));
    f.close().await;
}

#[tokio::test]
async fn local_deadline_control_never_creates_a_browser_replay_tuple() {
    let f = Case::new().await;
    let run = RunId(Uuid::new_v4());
    let (control, mut receiver) = f.registry.register(f.store.clone(), &run).unwrap();
    control.set_available(true);
    control.publish(f.receipt(&run)).unwrap();
    assert!(receiver.take().unwrap().is_some());
    assert!(f
        .registry
        .request(&f.owner, &f.conversation, &input(&run))
        .is_none());
    drop((control, receiver));
    assert!(f
        .registry
        .request(&f.owner, &f.conversation, &input(&run))
        .is_none());
    f.close().await;
}
