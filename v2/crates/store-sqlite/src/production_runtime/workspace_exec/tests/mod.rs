use super::*;
use crate::production_runtime::{
    observation_tests::input,
    tests::{claim, ready, setup, Case},
};
use std::{os::unix::fs::MetadataExt, path::PathBuf};
mod authority_cases;
mod delivery_cases;
mod failure_cases;
mod upgrade_cases;

struct Fixture {
    f: Case,
    path: PathBuf,
    workspace: Arc<WorkspaceGrant>,
    profile: Arc<WorkspaceExecProfile>,
    parent: WorkspaceExecParent,
}
async fn fixture() -> Fixture {
    let f = setup().await;
    let path = f.root.with_extension("project");
    std::fs::create_dir_all(path.join(".git")).unwrap();
    let allow = WorkspaceOperatorAllowlist::new(
        vec![path.clone()],
        vec![f.root.clone()],
        std::fs::metadata(&path).unwrap().uid(),
    )
    .unwrap();
    let workspace = Arc::new(
        f.handle
            .register_workspace(
                &f.token,
                &f.conversation,
                Uuid::new_v4(),
                allow.installation(&path).unwrap(),
            )
            .await
            .unwrap(),
    );
    let profile = Arc::new(
        f.handle
            .install_workspace_exec(&f.token, &workspace)
            .await
            .unwrap(),
    );
    let deep = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    f.handle
        .bind_workspace_session(&f.token, &workspace, &deep)
        .await
        .unwrap();
    let deep = ready(&f).await;
    let source = claim(&f, &deep).await;
    let candidate = f
        .handle
        .admit_run(&source, &deep.session_id, deep.generation, "parent")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&candidate, "parent-dispatch")
        .await
        .unwrap()
    else {
        panic!("reserve")
    };
    let ExecutionConsumption::Dispatch(capability) =
        f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!("consume")
    };
    let deep_run = capability.provider().clone();
    assert!(f
        .handle
        .authorize_workspace_exec_parent(&f.token, &capability, &profile)
        .await
        .is_err());
    f.handle
        .append_provider_event(
            &f.owner,
            &deep_run,
            &input(&deep_run, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    drop(capability);
    let worker = f
        .handle
        .create_worker_binding(&f.owner, &f.conversation, Some(&deep.session_id), "worker")
        .await
        .unwrap();
    f.handle
        .bind_workspace_session(&f.token, &workspace, &worker)
        .await
        .unwrap();
    let metadata = f
        .handle
        .authorize_worker_metadata(&f.token, &deep_run.run.run_id, &worker)
        .await
        .unwrap();
    let worker = f
        .handle
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: worker.session_id,
                expected_generation: worker.generation,
                native_session_id: "synthetic-worker".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "worker-ready".into(),
            },
        )
        .await
        .unwrap()
        .binding()
        .clone();
    let WorkerDelegationResult::Fresh(delegated) = f
        .handle
        .delegate_worker(
            &f.token,
            &deep_run.run.run_id,
            &WorkerAdmissionInput {
                worker_binding_id: worker.session_id,
                expected_binding_generation: worker.generation,
                source_message_id: source.message_id,
                source_event_id: source.event_id,
                request_key: "worker-task".into(),
                lifetime_ms: 30000,
            },
        )
        .await
        .unwrap()
    else {
        panic!("delegate")
    };
    let admitted = f.handle.admit_worker(&f.token, delegated).await.unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&admitted, "worker-dispatch")
        .await
        .unwrap()
    else {
        panic!("reserve")
    };
    let ExecutionConsumption::Dispatch(capability) =
        f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!("consume")
    };
    let parent = f
        .handle
        .authorize_workspace_exec_parent(&f.token, &capability, &profile)
        .await
        .unwrap();
    f.handle
        .append_provider_event(
            &f.owner,
            capability.provider(),
            &input(capability.provider(), 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    drop(capability);
    Fixture {
        f,
        path,
        workspace,
        profile,
        parent,
    }
}
fn call(number: u64) -> WorkspaceExecNativeCall {
    WorkspaceExecNativeCall {
        request_id: WorkspaceExecNativeRequestId::Integer(number),
        call_id: format!("call:{number}"),
        thread_id: "synthetic-worker".into(),
        turn_id: "turn:1".into(),
    }
}
async fn delegated(x: &Fixture, number: u64) -> WorkspaceExecDelegation {
    let WorkspaceExecAdmission::Fresh(grant) =
        x.f.handle
            .delegate_native_workspace_exec(
                &x.f.token,
                &x.parent,
                &call(number),
                "printf operational",
                5000,
            )
            .await
            .unwrap()
    else {
        panic!("grant")
    };
    grant
}
async fn consumed(x: &Fixture, number: u64) -> ConsumedWorkspaceExec {
    let WorkspaceExecConsumption::Launch(launch) =
        x.f.handle
            .consume_workspace_exec(&x.f.token, delegated(x, number).await)
            .await
            .unwrap()
    else {
        panic!("launch")
    };
    launch
}
fn duplicate(g: &WorkspaceExecDelegation) -> WorkspaceExecDelegation {
    WorkspaceExecDelegation {
        profile: g.profile.clone(),
        id: g.id,
        parent: g.parent.clone(),
        context_id: g.context_id.clone(),
        incarnation: g.incarnation.clone(),
        locator: g.locator.clone(),
        source_digest: g.source_digest.clone(),
        expires_at_ms: g.expires_at_ms,
    }
}
async fn cleanup(x: Fixture) {
    x.f.store.close().await;
    std::fs::remove_dir_all(&x.f.root).unwrap();
    std::fs::remove_dir_all(&x.path).unwrap();
}
