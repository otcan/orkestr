//! Actual Store issuance fixture derived from the public df9c232e source oracle.
//! This separate fixture adds bound context for actual owned-writer tests.
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{MessageInput, OwnerId};
use orkestr_v2_store_sqlite::*;
use std::{path::PathBuf, time::Duration};

pub(super) struct Fixture {
    pub store: Store,
    pub root: PathBuf,
    pub delivery: Box<ConsumedSteering>,
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
    let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated synthetic home"))
        .join(format!("runtime-steering-{}-{label}", std::process::id()));
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
    let issuer = handle.authorize_codex_steering(&parent).await.unwrap();
    handle
        .bind_codex_steering_turn(&issuer, "native-turn:1")
        .await
        .unwrap();
    let status = handle
        .execution_run_status(&token, &owner, &conversation, &parent.provider().run.run_id)
        .await
        .unwrap()
        .unwrap();
    let request = orkestr_v2_contracts::ExecutionSteeringRequest {
        control: orkestr_v2_contracts::ExecutionControlRequest {
            run_id: parent.provider().run.run_id.clone(),
            expected_revision: status.revision,
            expected_control_revision: status.control_revision,
            request_key: "steer:1".into(),
        },
        text: "synthetic changed requirement".into(),
    };
    let (_, reservation) = handle
        .steer_execution_authenticated(&token, &conversation, &request, Some(&issuer))
        .await
        .unwrap();
    let SteeringConsumption::Deliver(delivery) = handle
        .consume_codex_steering(reservation.unwrap())
        .await
        .unwrap()
    else {
        panic!("fresh steer")
    };
    Fixture {
        namespace: parent.namespace().into(),
        incarnation: parent.incarnation_id().into(),
        store,
        root,
        delivery,
        bound: handle,
        token,
    }
}
