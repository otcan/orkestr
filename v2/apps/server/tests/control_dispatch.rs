//! Bounded handoff tests using ordinary Store-issued cancellation receipts.
//! These assert queue/replay semantics, not provider interruption or HTTP wiring.
#[path = "../src/control_dispatch.rs"]
#[allow(dead_code)]
mod control_dispatch;
#[path = "../src/stop_execution/mod.rs"]
#[allow(dead_code)]
mod stop_execution;

use control_dispatch::{mailbox, ControlReceiver, ControlSender, HandoffError};
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ConversationId, MessageInput, OwnerId, RunId};
use orkestr_v2_store_sqlite::Store;
use std::{path::PathBuf, sync::Arc, time::Duration};
use uuid::Uuid;

struct Case {
    store: Store,
    root: PathBuf,
    receipt: CancelReceipt,
}
impl Case {
    async fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"))
            .join(format!("control-mailbox-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic-owner", "synthetic-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        let token = "ab".repeat(32);
        store.save_session(&token, &owner).await.unwrap();
        let store = store
            .authorize_supervisor(
                &token,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: "synthetic-control-mailbox".into(),
                    supervisor_key: "synthetic-supervisor".into(),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .unwrap();
        let binding = store
            .ensure_role_bindings(&owner, &conversation)
            .await
            .unwrap()
            .deep;
        let binding = store
            .confirm_native_session(NativeSessionConfirmation {
                session_id: binding.session_id,
                expected_generation: binding.generation,
                native_session_id: "synthetic-control-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "ready:1".into(),
            })
            .await
            .unwrap();
        store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: "input:1".into(),
                    text: "synthetic input".into(),
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
        let admission = store
            .admit_run(&claim, &binding.session_id, binding.generation, "run:1")
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reservation) = store
            .claim_provider_dispatch(&admission, "dispatch:1")
            .await
            .unwrap()
        else {
            panic!("fresh reservation required")
        };
        assert!(matches!(
            store.consume_execution(&reservation).await.unwrap(),
            orkestr_v2_store_sqlite::ExecutionConsumption::Dispatch(_)
        ));
        let receipt = store
            .request_cancel(&owner, &admission.provider.run.run_id, "cancel:1")
            .await
            .unwrap();
        assert_eq!(receipt.state, RunState::CancelRequested);
        assert_eq!(receipt.inflight_status, InflightStatus::Unknown);
        Self {
            store,
            root,
            receipt,
        }
    }
    fn mailbox(&self) -> (ControlSender, ControlReceiver) {
        let run = &self.receipt.new_fenced_admission;
        mailbox(
            self.store.clone(),
            run.owner_id.clone(),
            run.conversation_id.clone(),
            run.run_id.clone(),
        )
        .unwrap()
    }
    async fn close(self) {
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

#[tokio::test]
async fn exact_committed_replay_survives_take_and_receiver_cleanup_without_redelivery() {
    let case = Case::new().await;
    let (sender, mut receiver) = case.mailbox();
    assert!(sender.is_open());
    assert!(receiver.take().unwrap().is_none());
    sender.publish(case.receipt.clone()).unwrap();
    assert!(receiver.take().unwrap().is_some());
    let run = &case.receipt.new_fenced_admission;
    let replay = case
        .store
        .request_cancel(&run.owner_id, &run.run_id, "cancel:1")
        .await
        .unwrap();
    assert_eq!(replay, case.receipt);
    sender.publish(replay.clone()).unwrap();
    assert!(receiver.take().unwrap().is_none());
    drop(receiver);
    assert!(!sender.is_open());
    sender.publish(replay).unwrap();
    let mut changed = case.receipt.clone();
    changed.new_fenced_admission.dispatch_fence += 1;
    assert_eq!(sender.publish(changed), Err(HandoffError::Conflict));
    case.close().await;
}

#[tokio::test]
async fn foreign_scope_and_non_control_purpose_do_not_occupy_the_slot() {
    let case = Case::new().await;
    let (sender, mut receiver) = case.mailbox();
    for field in 0..4 {
        let mut wrong = case.receipt.clone();
        match field {
            0 => wrong.new_fenced_admission.owner_id = OwnerId(Uuid::new_v4()),
            1 => wrong.new_fenced_admission.conversation_id = ConversationId(Uuid::new_v4()),
            2 => wrong.new_fenced_admission.run_id = RunId(Uuid::new_v4()),
            _ => wrong.new_fenced_admission.purpose = AdmissionPurpose::Execution,
        }
        assert_eq!(sender.publish(wrong), Err(HandoffError::WrongScope));
        assert!(receiver.take().unwrap().is_none());
    }
    sender.publish(case.receipt.clone()).unwrap();
    assert!(receiver.take().unwrap().is_some());
    drop(receiver);
    case.close().await;
}

#[tokio::test]
async fn first_publish_after_cleanup_refuses_even_if_cancellation_committed() {
    let case = Case::new().await;
    let (sender, receiver) = case.mailbox();
    drop(receiver);
    assert!(!sender.is_open());
    assert_eq!(
        sender.publish(case.receipt.clone()),
        Err(HandoffError::Closed)
    );
    assert_eq!(
        sender.clone().publish(case.receipt.clone()),
        Err(HandoffError::Closed)
    );
    case.close().await;
}

#[tokio::test]
async fn concurrent_authenticated_replay_has_one_delivery() {
    let case = Case::new().await;
    let (sender, mut receiver) = case.mailbox();
    let barrier = Arc::new(std::sync::Barrier::new(8));
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let sender = sender.clone();
            let receipt = case.receipt.clone();
            let barrier = Arc::clone(&barrier);
            scope.spawn(move || {
                barrier.wait();
                sender.publish(receipt).unwrap();
            });
        }
    });
    assert!(receiver.take().unwrap().is_some());
    assert!(receiver.take().unwrap().is_none());
    drop(receiver);
    case.close().await;
}

#[tokio::test]
async fn first_publish_and_cleanup_race_has_one_atomic_outcome() {
    let case = Case::new().await;
    for _ in 0..16 {
        let (sender, receiver) = case.mailbox();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let other = Arc::clone(&barrier);
        let result = std::thread::scope(|scope| {
            scope.spawn(move || {
                other.wait();
                drop(receiver);
            });
            barrier.wait();
            sender.publish(case.receipt.clone())
        });
        assert!(matches!(result, Ok(()) | Err(HandoffError::Closed)));
        assert!(!sender.is_open());
        assert_eq!(sender.publish(case.receipt.clone()), result);
    }
    case.close().await;
}

#[tokio::test]
async fn empty_run_registration_is_refused() {
    let case = Case::new().await;
    let run = &case.receipt.new_fenced_admission;
    for field in 0..3 {
        let owner = if field == 0 {
            OwnerId(Uuid::nil())
        } else {
            run.owner_id.clone()
        };
        let conversation = if field == 1 {
            ConversationId(Uuid::nil())
        } else {
            run.conversation_id.clone()
        };
        let id = if field == 2 {
            RunId(Uuid::nil())
        } else {
            run.run_id.clone()
        };
        assert!(matches!(
            mailbox(case.store.clone(), owner, conversation, id),
            Err(HandoffError::WrongScope)
        ));
    }
    case.close().await;
}
