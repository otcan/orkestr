use super::*;
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ConversationId, MessageInput, OwnerId};
use orkestr_v2_store_sqlite::{
    ConsumedProviderDispatch, ExecutionConsumption, OfflinePythonAdmission, OfflinePythonState,
};
use std::{path::PathBuf, sync::atomic::Ordering};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
struct Case {
    root: PathBuf,
    store: Store,
    handle: Store,
    owner: OwnerId,
    conversation: ConversationId,
    token: String,
    parent: ConsumedProviderDispatch,
}
impl Case {
    async fn new() -> Self {
        let root =
            PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated synthetic home"))
                .join(format!("offline-python-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic-owner", "synthetic-password-hash")
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
        let handle = store
            .authorize_supervisor(
                &token,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: "synthetic-offline-tool".into(),
                    supervisor_key: "synthetic-parent".into(),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .unwrap();
        let roles = handle
            .ensure_role_bindings(&owner, &conversation)
            .await
            .unwrap();
        let binding = handle
            .confirm_native_session(NativeSessionConfirmation {
                session_id: roles.deep.session_id,
                expected_generation: roles.deep.generation,
                native_session_id: "synthetic-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "synthetic-ready".into(),
            })
            .await
            .unwrap();
        store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: "synthetic-parent-input".into(),
                    text: "synthetic parent metadata; no provider process".into(),
                },
            )
            .await
            .unwrap();
        let claim = handle
            .claim_next(
                &owner,
                &conversation,
                &binding.session_id,
                Duration::from_secs(60),
            )
            .await
            .unwrap()
            .unwrap();
        let candidate = handle
            .admit_run(&claim, &binding.session_id, binding.generation, "parent")
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reserved) = handle
            .claim_provider_dispatch(&candidate, "parent-dispatch")
            .await
            .unwrap()
        else {
            panic!("reservation");
        };
        let ExecutionConsumption::Dispatch(parent) =
            handle.consume_execution(&reserved).await.unwrap()
        else {
            panic!("consumed parent");
        };
        Self {
            root,
            store,
            handle,
            owner,
            conversation,
            token,
            parent: *parent,
        }
    }
    async fn grant(&self, key: &str, source: &str) -> OfflinePythonDelegation {
        let OfflinePythonAdmission::Fresh(grant) = self
            .handle
            .delegate_offline_python(&self.token, &self.parent, key, source, 5000)
            .await
            .unwrap()
        else {
            panic!("fresh tool grant");
        };
        grant
    }
    fn dispatcher(&self) -> OfflinePythonDispatcher {
        OfflinePythonDispatcher::opt_in(self.handle.clone(), self.token.clone()).unwrap()
    }
    async fn cleanup(self) {
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

async fn wait_started(dispatcher: &OfflinePythonDispatcher) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while dispatcher.spawned.load(Ordering::Acquire) == 0 {
        assert!(Instant::now() < deadline, "owned worker never spawned");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}
async fn wait_reaped() {
    let (_, active) = GATES.get().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while active.available_permits() != CONCURRENT {
        assert!(
            Instant::now() < deadline,
            "blocking owner has not completed cleanup"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_store_to_actual_sandbox_returns_bound_output_without_accepting_parent() {
    let _serial = SERIAL.lock().await;
    let f = Case::new().await;
    let dispatcher = f.dispatcher();
    let source = "print('synthetic-tool-output')";
    let grant = f.grant("tool", source).await;
    let id = grant.id();
    let (_control, signals) = offline_python_controls();
    let OfflinePythonResult::Finished {
        receipt,
        output: Some(output),
    } = dispatcher.run(grant, signals).await
    else {
        panic!("completed sandbox call");
    };
    assert_eq!(receipt.delegation_id, id);
    assert_eq!(receipt.parent_run_id, f.parent.provider().run.run_id);
    assert_eq!(receipt.conversation_id, f.conversation);
    assert_eq!(receipt.state, OfflinePythonState::Completed);
    assert_eq!(output.stdout, b"synthetic-tool-output\n");
    assert_eq!(dispatcher.spawned.load(Ordering::Acquire), 1);
    let OfflinePythonAdmission::Existing(replay) = f
        .handle
        .delegate_offline_python(&f.token, &f.parent, "tool", source, 5000)
        .await
        .unwrap()
    else {
        panic!("receipt replay only");
    };
    assert_eq!(receipt, replay);
    let status = f
        .handle
        .inspect_production_attempt(&f.conversation, "parent")
        .await
        .unwrap()
        .unwrap();
    assert!(!status.blocked);
    f.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_and_logout_before_dispatch_never_spawn() {
    let _serial = SERIAL.lock().await;
    for revoke in [false, true] {
        let f = Case::new().await;
        let dispatcher = f.dispatcher();
        let grant = f.grant("tool", "print('must-not-run')").await;
        if revoke {
            f.store.revoke_session(&f.token).await.unwrap();
        } else {
            f.handle
                .request_cancel(&f.owner, &f.parent.provider().run.run_id, "stop-before")
                .await
                .unwrap();
        }
        let (_control, signals) = offline_python_controls();
        assert!(matches!(
            dispatcher.run(grant, signals).await,
            OfflinePythonResult::Refused { .. }
        ));
        assert_eq!(dispatcher.spawned.load(Ordering::Acquire), 0);
        f.cleanup().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn durable_stop_during_actual_child_reaps_then_acknowledges_exact_delegation() {
    let _serial = SERIAL.lock().await;
    let f = Case::new().await;
    let dispatcher = Arc::new(f.dispatcher());
    let grant = f.grant("tool", "while True: pass").await;
    let id = grant.id();
    let (control, signals) = offline_python_controls();
    let d = dispatcher.clone();
    let work = tokio::spawn(async move { d.run(grant, signals).await });
    wait_started(&dispatcher).await;
    let stop = f
        .handle
        .request_cancel(&f.owner, &f.parent.provider().run.run_id, "stop-live")
        .await
        .unwrap();
    let mut authority = f.parent.provider().clone();
    authority.run = stop.new_fenced_admission;
    control.observe_durable_stop(authority);
    let OfflinePythonResult::Finished {
        receipt,
        output: None,
    } = work.await.unwrap()
    else {
        panic!("durable cancellation acknowledgement");
    };
    assert_eq!(receipt.delegation_id, id);
    assert_eq!(receipt.state, OfflinePythonState::Cancelled);
    wait_reaped().await;
    f.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn logout_during_child_quarantines_output_and_preserves_unknown() {
    let _serial = SERIAL.lock().await;
    let f = Case::new().await;
    let dispatcher = Arc::new(f.dispatcher());
    let grant = f
        .grant(
            "tool",
            "print('must-stay-quarantined', flush=True)\nwhile True: pass",
        )
        .await;
    let id = grant.id();
    let (_control, signals) = offline_python_controls();
    let d = dispatcher.clone();
    let work = tokio::spawn(async move { d.run(grant, signals).await });
    wait_started(&dispatcher).await;
    f.store.revoke_session(&f.token).await.unwrap();
    let OfflinePythonResult::Unknown { receipt, .. } = work.await.unwrap() else {
        panic!("revoked output must be quarantined");
    };
    assert_eq!(receipt.delegation_id, id);
    assert_eq!(receipt.state, OfflinePythonState::DeliveryUnknown);
    wait_reaped().await;
    f.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queue_deadline_and_capacity_preserve_unconsumed_grant() {
    let _serial = SERIAL.lock().await;
    let f = Case::new().await;
    let dispatcher = f.dispatcher();
    let (total, active) = GATES.get_or_init(|| {
        (
            Arc::new(Semaphore::new(TOTAL)),
            Arc::new(Semaphore::new(CONCURRENT)),
        )
    });
    let full = total
        .clone()
        .acquire_many_owned(TOTAL as u32)
        .await
        .unwrap();
    let grant = f.grant("tool", "print('after-queue')").await;
    let (_, signals) = offline_python_controls();
    let OfflinePythonResult::NotDispatched {
        delegation,
        reason: QueueRefusal::Full,
    } = dispatcher.run(grant, signals).await
    else {
        panic!("capacity refusal");
    };
    drop(full);
    let busy = active
        .clone()
        .acquire_many_owned(CONCURRENT as u32)
        .await
        .unwrap();
    let (_, signals) = offline_python_controls();
    let started = Instant::now();
    let OfflinePythonResult::NotDispatched {
        delegation,
        reason: QueueRefusal::Deadline,
    } = dispatcher.run(delegation, signals).await
    else {
        panic!("bounded queue expiry");
    };
    assert!(started.elapsed() < Duration::from_secs(1));
    let OfflinePythonAdmission::Existing(receipt) = f
        .handle
        .delegate_offline_python(&f.token, &f.parent, "tool", "print('after-queue')", 5000)
        .await
        .unwrap()
    else {
        panic!("delegation metadata");
    };
    assert_eq!(receipt.state, OfflinePythonState::Delegated);
    assert_eq!(receipt.revision, 1);
    assert_eq!(dispatcher.spawned.load(Ordering::Acquire), 0);
    drop(busy);
    let (_, signals) = offline_python_controls();
    assert!(matches!(
        dispatcher.run(delegation, signals).await,
        OfflinePythonResult::Finished {
            output: Some(_),
            ..
        }
    ));
    f.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_request_keeps_blocking_owner_until_child_cleanup() {
    let _serial = SERIAL.lock().await;
    let f = Case::new().await;
    let dispatcher = Arc::new(f.dispatcher());
    let grant = f.grant("tool", "while True: pass").await;
    let (_, signals) = offline_python_controls();
    let d = dispatcher.clone();
    let work = tokio::spawn(async move { d.run(grant, signals).await });
    wait_started(&dispatcher).await;
    work.abort();
    assert!(matches!(work.await,Err(error) if error.is_cancelled()));
    wait_reaped().await;
    let OfflinePythonAdmission::Existing(receipt) = f
        .handle
        .delegate_offline_python(&f.token, &f.parent, "tool", "while True: pass", 5000)
        .await
        .unwrap()
    else {
        panic!("consume evidence");
    };
    assert_eq!(receipt.state, OfflinePythonState::DeliveryUnknown);
    f.cleanup().await;
}

#[test]
fn output_encoding_is_ordered_and_unambiguous() {
    let mut output = WorkerOutput {
        exit_code: Some(0),
        signal: None,
        stdout: b"abc".to_vec(),
        stderr: b"d".to_vec(),
    };
    let original = output::digest(&output);
    assert_eq!(
        original,
        "8adb46473cb1fb09ecc2b28f3f8901f5a69b65c5515636d1c8e6d1ff3a97aa42"
    );
    output.stdout = b"ab".to_vec();
    output.stderr = b"cd".to_vec();
    assert_ne!(original, output::digest(&output));
    output.exit_code = Some(1);
    assert_ne!(original, output::digest(&output));
    assert_ne!(
        output::failure_digest(WorkerSandboxError::Timeout),
        output::failure_digest(WorkerSandboxError::OutputLimit)
    );
}
