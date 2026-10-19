use super::*;
use crate::production_runtime::{
    observation_tests::input,
    tests::{claim, ready, setup},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopped_resume_checks_pending_descendants_at_issue_fence_and_confirm() {
    let f = setup().await;
    let binding = ready(&f).await;
    let claimed = claim(&f, &binding).await;
    let admitted = f
        .handle
        .admit_run(
            &claimed,
            &binding.session_id,
            binding.generation,
            "stopped-parent",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reserved) = f
        .handle
        .claim_provider_dispatch(&admitted, "stopped-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&reserved).await.unwrap()
    else {
        panic!()
    };
    let parent = cap.provider().clone();
    f.handle
        .append_provider_event(
            &f.owner,
            &parent,
            &input(&parent, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM production_control_revisions WHERE run_id=?")
            .bind(parent.run.run_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    f.handle
        .create_worker_task_authenticated(
            &f.token,
            &f.conversation,
            &orkestr_v2_contracts::WorkerTaskCreateRequest {
                parent_run_id: parent.run.run_id.clone(),
                expected_control_revision: revision,
                request_key: "pending-stop-task".into(),
                title: "Synthetic".into(),
                instructions: "Retain held input".into(),
                lifetime_ms: 30_000,
                execution_budget_ms: None,
            },
        )
        .await
        .unwrap();
    let cancel = f
        .handle
        .request_cancel(&f.owner, &parent.run.run_id, "parent-stop")
        .await
        .unwrap();
    let mut control = parent.clone();
    control.run = cancel.new_fenced_admission;
    f.handle
        .append_provider_event(
            &f.owner,
            &control,
            &input(&control, 2, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
    let ready = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    // Adversarial persisted pending suffix: issuance must roll back its reservation.
    sqlx::query("UPDATE worker_tasks SET state='queued',claim_hash=NULL")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(matches!(
        f.handle
            .authorize_stopped_session_metadata(&f.token, &parent.run.run_id, &ready)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM production_resume_metadata")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::query("UPDATE worker_tasks SET state='held',claim_hash=NULL")
        .execute(&f.store.pool)
        .await
        .unwrap();
    let grant = f
        .handle
        .authorize_stopped_session_metadata(&f.token, &parent.run.run_id, &ready)
        .await
        .unwrap();
    assert_eq!(
        f.handle
            .with_metadata_fence(&grant, || Ok::<_, ()>(1))
            .unwrap(),
        Ok(1)
    );
    // A newly observed unresolved ledger suffix must fence an already issued grant.
    sqlx::query("UPDATE worker_tasks SET state='claimed',claim_hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'")
        .execute(&f.store.pool)
        .await
        .unwrap();
    let mut calls = 0;
    assert!(matches!(
        f.handle.with_metadata_fence(&grant, || {
            calls += 1;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(calls, 0);
    assert!(matches!(
        f.handle
            .confirm_metadata_session(
                grant,
                NativeSessionConfirmation {
                    session_id: ready.session_id,
                    expected_generation: ready.generation,
                    native_session_id: ready.native_session_id.unwrap(),
                    protocol_version: "codex-rpc-1".into(),
                    source_event_key: "stopped-descendant-confirm".into(),
                }
            )
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    let state: String = sqlx::query_scalar("SELECT state FROM production_resume_metadata")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "issued");
}

#[tokio::test]
async fn stopped_parent_with_confirmed_unresolved_worker_setup_cannot_resume() {
    let f = setup().await;
    // This helper confirms an actual distinct Worker metadata binding but does
    // not admit its run. A stopped parent is insufficient to settle that setup.
    let (parent, _) = crate::production_runtime::worker::tests::running(&f).await;
    let cancel = f
        .handle
        .request_cancel(&f.owner, &parent.run.run_id, "stop-with-setup")
        .await
        .unwrap();
    let mut control = parent.clone();
    control.run = cancel.new_fenced_admission;
    f.handle
        .append_provider_event(
            &f.owner,
            &control,
            &input(&control, 2, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let before = crate::production_runtime::tests::snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .authorize_stopped_session_metadata(&f.token, &parent.run.run_id, &binding)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(
        crate::production_runtime::tests::snapshot(&f.store).await,
        before
    );
}
