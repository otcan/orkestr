use super::*;
use crate::production_runtime::observation_tests::input;
use crate::production_runtime::tests::{setup, Case};
mod admission;
mod delivery;
mod fencing;
mod upgrade;

async fn worker(f: &Case) -> (ProviderAdmission, OfflinePythonParent) {
    let (parent, input) = crate::production_runtime::worker::tests::running(f).await;
    let WorkerDelegationResult::Fresh(grant) = f
        .handle
        .delegate_worker(&f.token, &parent.run.run_id, &input)
        .await
        .unwrap()
    else {
        panic!("Worker grant")
    };
    let run = f.handle.admit_worker(&f.token, grant).await.unwrap();
    let DispatchClaimResult::Reserved(reserved) = f
        .handle
        .claim_provider_dispatch(&run, "worker-dispatch")
        .await
        .unwrap()
    else {
        panic!("Worker reserve")
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&reserved).await.unwrap()
    else {
        panic!("Worker consume")
    };
    let retained = f
        .handle
        .authorize_offline_python_parent(&f.token, &cap)
        .await
        .unwrap();
    f.handle
        .append_provider_event(
            &f.owner,
            cap.provider(),
            &crate::production_runtime::observation_tests::input(
                cap.provider(),
                1,
                ProviderEvent::Started,
            ),
        )
        .await
        .unwrap();
    drop(cap);
    (parent, retained)
}
fn call(number: u64) -> OfflinePythonNativeCall {
    OfflinePythonNativeCall {
        request_id: OfflinePythonNativeRequestId::Integer(number),
        call_id: format!("call:{number}"),
        thread_id: "synthetic-native-worker".into(),
        turn_id: "turn:1".into(),
    }
}
async fn grant(
    f: &Case,
    parent: &OfflinePythonParent,
    call: &OfflinePythonNativeCall,
) -> OfflinePythonDelegation {
    let OfflinePythonAdmission::Fresh(grant) = f
        .handle
        .delegate_native_offline_python(&f.token, parent, call, "print(1)", 5000)
        .await
        .unwrap()
    else {
        panic!("fresh grant")
    };
    grant
}
async fn launch(f: &Case, grant: OfflinePythonDelegation) -> ConsumedOfflinePython {
    let OfflinePythonConsumption::Launch(launch) = f
        .handle
        .consume_offline_python(&f.token, grant)
        .await
        .unwrap()
    else {
        panic!("launch")
    };
    launch
}
fn output() -> OfflinePythonOutput {
    OfflinePythonOutput {
        stdout: b"1\n".to_vec(),
        stderr: Vec::new(),
        exit_code: Some(0),
        signal: None,
    }
}
async fn prepared(
    f: &Case,
    parent: &OfflinePythonParent,
    number: u64,
) -> (ConsumedOfflinePython, OfflinePythonResultReservation) {
    let launch = launch(f, grant(f, parent, &call(number)).await).await;
    // Store unit tests attest a synthetic executor; actual sandbox tests are separate.
    f.handle
        .with_offline_python_fence(&f.token, &launch, || Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
    let OfflinePythonResultPreparation::Reserved(reservation) = f
        .handle
        .prepare_offline_python_result(&f.token, &launch, &output())
        .await
        .unwrap()
    else {
        panic!("reservation")
    };
    (launch, reservation)
}
async fn delivery(f: &Case, parent: &OfflinePythonParent, number: u64) -> CompletedToolDelivery {
    let (_, reservation) = prepared(f, parent, number).await;
    let OfflinePythonResultConsumption::Deliver(delivery) = f
        .handle
        .consume_offline_python_result(&f.token, reservation)
        .await
        .unwrap()
    else {
        panic!("delivery")
    };
    delivery
}
fn duplicate(value: &OfflinePythonResultReservation) -> OfflinePythonResultReservation {
    // Only issuing-crate tests can model duplicated private capability delivery.
    let l = &value.launch;
    OfflinePythonResultReservation {
        launch: Box::new(types::ResultLineage {
            id: l.id,
            parent: l.parent.clone(),
            context_id: l.context_id.clone(),
            incarnation: l.incarnation.clone(),
            source_digest: l.source_digest.clone(),
            expires_at_ms: l.expires_at_ms,
        }),
        locator: value.locator.clone(),
        call: value.call.clone(),
        output_digest: value.output_digest.clone(),
        text: value.text.clone(),
        success: value.success,
    }
}
async fn state(f: &Case, id: Uuid) -> (String, i64) {
    sqlx::query_as("SELECT state,written_bytes FROM worker_tool_results WHERE delegation_id=?")
        .bind(id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}
async fn cleanup(f: Case) {
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}
