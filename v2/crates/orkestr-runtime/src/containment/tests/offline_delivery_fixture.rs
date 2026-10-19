//! Actual Store issuance fixture derived from the public df9c232e source oracle.
//! This separate fixture adds bound context for actual owned-writer tests.
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{MessageInput, OwnerId};
use orkestr_v2_store_sqlite::*;
use std::{path::PathBuf, time::Duration};

pub(super) struct Fixture {
    pub store: Store,
    pub root: PathBuf,
    pub delivery: CompletedToolDelivery,
    pub bound: Store,
    pub token: String,
    pub namespace: String,
    pub incarnation: String,
}

async fn started(store: &Store, owner: &OwnerId, p: &ProviderAdmission) {
    store
        .append_provider_event(
            owner,
            p,
            &ProviderEventInput {
                run_id: p.run.run_id.clone(),
                session_id: p.run.session_id.clone(),
                lease_generation: p.run.lease_generation,
                dispatch_fence: p.run.dispatch_fence,
                sequence: 1,
                event: ProviderEvent::Started,
            },
        )
        .await
        .unwrap();
}

pub(super) async fn issued(label: &str) -> Fixture {
    let home = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated synthetic home"));
    std::fs::create_dir_all(&home).unwrap();
    let root = home.join(format!(
        "runtime-source-oracle-{}-{label}",
        std::process::id()
    ));
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
            native_session_id: "synthetic-parent-native".into(),
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
                client_message_id: "synthetic-input".into(),
                text: "synthetic parent task".into(),
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
    let admitted = handle
        .admit_run(&claim, &binding.session_id, binding.generation, "parent")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = handle
        .claim_provider_dispatch(&admitted, "parent-dispatch")
        .await
        .unwrap()
    else {
        panic!("parent reservation")
    };
    let ExecutionConsumption::Dispatch(parent) =
        handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!("parent dispatch")
    };
    started(&handle, &owner, parent.provider()).await;
    let worker = handle
        .create_worker_binding(
            &owner,
            &conversation,
            Some(&parent.provider().run.session_id),
            "worker",
        )
        .await
        .unwrap();
    let metadata = handle
        .authorize_worker_metadata(&token, &parent.provider().run.run_id, &worker)
        .await
        .unwrap();
    let worker = handle
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: worker.session_id,
                expected_generation: worker.generation,
                native_session_id: "synthetic-worker-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "worker-ready".into(),
            },
        )
        .await
        .unwrap()
        .binding()
        .clone();
    let WorkerDelegationResult::Fresh(delegation) = handle
        .delegate_worker(
            &token,
            &parent.provider().run.run_id,
            &WorkerAdmissionInput {
                worker_binding_id: worker.session_id,
                expected_binding_generation: worker.generation,
                source_message_id: parent.message_id().clone(),
                source_event_id: parent.source_event_id().clone(),
                request_key: "worker".into(),
                lifetime_ms: 30_000,
            },
        )
        .await
        .unwrap()
    else {
        panic!("worker delegation")
    };
    let admitted = handle.admit_worker(&token, delegation).await.unwrap();
    let DispatchClaimResult::Reserved(reservation) = handle
        .claim_provider_dispatch(&admitted, "worker-dispatch")
        .await
        .unwrap()
    else {
        panic!("worker reservation")
    };
    let ExecutionConsumption::Dispatch(worker) =
        handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!("worker dispatch")
    };
    let namespace = worker.namespace().to_owned();
    let incarnation = worker.incarnation_id().to_owned();
    let retained = handle
        .authorize_offline_python_parent(&token, &worker)
        .await
        .unwrap();
    started(&handle, &owner, worker.provider()).await;
    let call = OfflinePythonNativeCall {
        request_id: OfflinePythonNativeRequestId::Text("native:1".into()),
        call_id: "call:1".into(),
        thread_id: "synthetic-worker-native".into(),
        turn_id: "turn:1".into(),
    };
    let OfflinePythonAdmission::Fresh(grant) = handle
        .delegate_native_offline_python(&token, &retained, &call, "print(1)", 5_000)
        .await
        .unwrap()
    else {
        panic!("tool delegation")
    };
    let OfflinePythonConsumption::Launch(launch) =
        handle.consume_offline_python(&token, grant).await.unwrap()
    else {
        panic!("tool launch")
    };
    // This oracle attests a synthetic executor only. Actual sandbox checks are separate.
    handle
        .with_offline_python_fence(&token, &launch, || Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
    let OfflinePythonResultPreparation::Reserved(reservation) = handle
        .prepare_offline_python_result(
            &token,
            &launch,
            &OfflinePythonOutput {
                stdout: b"1\n".to_vec(),
                stderr: Vec::new(),
                exit_code: Some(0),
                signal: None,
            },
        )
        .await
        .unwrap()
    else {
        panic!("result reservation")
    };
    let OfflinePythonResultConsumption::Deliver(delivery) = handle
        .consume_offline_python_result(&token, reservation)
        .await
        .unwrap()
    else {
        panic!("result delivery")
    };
    Fixture {
        store,
        root,
        delivery,
        bound: handle,
        token,
        namespace,
        incarnation,
    }
}
