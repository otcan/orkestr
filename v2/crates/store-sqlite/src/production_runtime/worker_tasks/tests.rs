use super::*;
use crate::production_runtime::observation_tests::input as observation;
use crate::production_runtime::tests::{setup, snapshot, Case};
use crate::production_runtime::worker::tests::running;
use orkestr_v2_contracts::ExecutionAcceptanceRequest;

struct Fixture {
    core: Case,
    parent: ProviderAdmission,
    binding: Binding,
    browser: String,
    request: WorkerTaskCreateRequest,
}
async fn fixture() -> Fixture {
    let core = setup().await;
    let (parent, input) = running(&core).await;
    let row = sqlx::query("SELECT * FROM session_bindings WHERE id=?")
        .bind(input.worker_binding_id.to_string())
        .fetch_one(&core.store.pool)
        .await
        .unwrap();
    let binding = crate::runtime::binding(&row).unwrap();
    let browser = format!("browser:{}", "ef".repeat(32));
    core.store
        .save_session(&browser, &core.owner)
        .await
        .unwrap();
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM production_control_revisions WHERE run_id=?")
            .bind(parent.run.run_id.to_string())
            .fetch_one(&core.store.pool)
            .await
            .unwrap();
    let request = WorkerTaskCreateRequest {
        parent_run_id: parent.run.run_id.clone(),
        expected_control_revision: revision,
        request_key: "owner-task:one".into(),
        title: "Summarize synthetic section one".into(),
        instructions:
            "Subtask one: summarize only synthetic section ONE.\nPreserve this exact text.".into(),
        lifetime_ms: 30_000,
    };
    Fixture {
        core,
        parent,
        binding,
        browser,
        request,
    }
}
async fn create(f: &Fixture) -> WorkerTaskReceipt {
    f.core
        .handle
        .create_worker_task_authenticated(&f.browser, &f.core.conversation, &f.request)
        .await
        .unwrap()
}
async fn claim(f: &Fixture) -> WorkerTaskClaim {
    f.core
        .handle
        .claim_worker_task(&f.core.token, &f.parent.run.run_id)
        .await
        .unwrap()
        .unwrap()
}
async fn candidate(f: &Fixture) -> RunAdmissionResult {
    let claim = claim(f).await;
    let grant = f
        .core
        .handle
        .delegate_worker_task(&f.core.token, claim, &f.binding)
        .await
        .unwrap();
    f.core
        .handle
        .admit_worker(&f.core.token, grant)
        .await
        .unwrap()
}
async fn reservation(f: &Fixture, run: &RunAdmissionResult) -> Box<DispatchClaim> {
    let DispatchClaimResult::Reserved(reserved) = f
        .core
        .handle
        .claim_provider_dispatch(run, "subtask-dispatch")
        .await
        .unwrap()
    else {
        panic!("fresh dispatch")
    };
    reserved
}
async fn consume(f: &Fixture, run: &RunAdmissionResult) -> Box<ConsumedProviderDispatch> {
    let reserved = reservation(f, run).await;
    let ExecutionConsumption::Dispatch(cap) =
        f.core.handle.consume_execution(&reserved).await.unwrap()
    else {
        panic!("fresh consumption")
    };
    cap
}
async fn statuses(f: &Fixture) -> WorkerTaskList {
    let list = f
        .core
        .handle
        .worker_tasks_authenticated(&f.browser, &f.core.conversation, &f.parent.run.run_id)
        .await
        .unwrap();
    assert!(list.is_valid());
    list
}
async fn audit(f: &Fixture) -> Vec<String> {
    let mut result = snapshot(&f.core.store).await;
    for query in [
        "SELECT json_object('id',id,'owner',owner_id,'conversation',conversation_id,'parent',parent_run_id,'context',context_id,'incarnation',incarnation_id,'control',parent_control_revision,'message',source_message_id,'event',source_event_id,'key',request_key,'digest',request_digest,'lifetime',lifetime_ms,'created',created_at_ms,'state',state,'claim',claim_hash,'delegation',delegation_id) FROM worker_tasks ORDER BY ordinal",
        "SELECT json_object('id',task_id,'title',title,'instructions',instructions) FROM worker_task_payloads ORDER BY task_id",
    ] {
        let rows: Vec<String> = sqlx::query_scalar(query).fetch_all(&f.core.store.pool).await.unwrap();
        result.push(format!("{rows:?}"));
    }
    result
}
async fn inbox(f: &Fixture) -> Vec<String> {
    sqlx::query_scalar("SELECT json_object('message',message_id,'state',state,'run',admitted_run_id) FROM reasoning_inbox ORDER BY sequence").fetch_all(&f.core.store.pool).await.unwrap()
}
async fn cleanup(f: Fixture) {
    f.core.store.close().await;
    std::fs::remove_dir_all(f.core.root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_subtask_consumes_once_and_only_owner_acceptance_completes_it() {
    let f = fixture().await;
    let original_inbox = inbox(&f).await;
    let (one, replay) = tokio::join!(
        f.core.handle.create_worker_task_authenticated(
            &f.browser,
            &f.core.conversation,
            &f.request
        ),
        f.core.handle.create_worker_task_authenticated(
            &f.browser,
            &f.core.conversation,
            &f.request
        )
    );
    let receipt = one.unwrap();
    assert_eq!(receipt, replay.unwrap());
    assert_eq!(statuses(&f).await.tasks[0].phase, WorkerTaskPhase::Queued);
    let claimed = claim(&f).await;
    assert_eq!(claimed.task_id(), &receipt.task_id);
    assert_eq!(claimed.source_message_id(), &receipt.source_message_id);
    assert_eq!(claimed.source_event_id(), &receipt.source_event_id);
    assert_eq!(claimed.parent(), &f.parent.run);
    assert_eq!(statuses(&f).await.tasks[0].phase, WorkerTaskPhase::Claimed);
    let grant = f
        .core
        .handle
        .delegate_worker_task(&f.core.token, claimed, &f.binding)
        .await
        .unwrap();
    assert_eq!(statuses(&f).await.tasks[0].phase, WorkerTaskPhase::Claimed);
    let run = f
        .core
        .handle
        .admit_worker(&f.core.token, grant)
        .await
        .unwrap();
    assert_eq!(
        statuses(&f).await.tasks[0].phase,
        WorkerTaskPhase::Preparing
    );
    let reserved = reservation(&f, &run).await;
    let ExecutionConsumption::Dispatch(cap) =
        f.core.handle.consume_execution(&reserved).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(cap.text(), f.request.instructions);
    assert_ne!(cap.text(), "synthetic execution payload");
    assert_eq!(cap.message_id(), &receipt.source_message_id);
    assert_eq!(cap.source_event_id(), &receipt.source_event_id);
    let worker = cap.provider().clone();
    drop(cap);
    assert!(matches!(
        f.core.handle.consume_execution(&reserved).await.unwrap(),
        ExecutionConsumption::ReconciliationRequired
    ));
    f.core
        .handle
        .append_provider_event(
            &f.core.owner,
            &worker,
            &observation(&worker, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    assert_eq!(statuses(&f).await.tasks[0].phase, WorkerTaskPhase::Running);
    let proposal = f
        .core
        .handle
        .append_provider_event(
            &f.core.owner,
            &worker,
            &observation(
                &worker,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        statuses(&f).await.tasks[0].phase,
        WorkerTaskPhase::AwaitingAcceptance
    );
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(f.core.conversation.to_string())
            .fetch_one(&f.core.store.pool)
            .await
            .unwrap();
    f.core
        .store
        .accept_execution_authenticated(
            &f.browser,
            &f.core.conversation,
            &ExecutionAcceptanceRequest {
                run_id: worker.run.run_id.clone(),
                completion_event_id: proposal.event_id,
                expected_revision: revision,
                request_key: "accept-subtask".into(),
            },
        )
        .await
        .unwrap();
    let status = statuses(&f).await;
    assert_eq!(status.tasks[0].phase, WorkerTaskPhase::Completed);
    assert_eq!(status.tasks[0].run_id, Some(worker.run.run_id));
    assert_eq!(inbox(&f).await, original_inbox);
    cleanup(f).await;
}

#[tokio::test]
async fn two_tasks_keep_distinct_instructions_and_native_bindings() {
    let mut f = fixture().await;
    let first = create(&f).await;
    f.request.request_key = "owner-task:two".into();
    f.request.instructions = "Subtask TWO: independently count synthetic rows only.".into();
    let second = create(&f).await;
    assert_ne!(first.task_id, second.task_id);
    let run = candidate(&f).await;
    let first_cap = consume(&f, &run).await;
    let first_text = first_cap.text().to_owned();
    let first_session = first_cap.provider().run.session_id.clone();
    drop(first_cap);
    let b = f
        .core
        .handle
        .create_worker_binding(
            &f.core.owner,
            &f.core.conversation,
            Some(&f.parent.run.session_id),
            "second-subtask-worker",
        )
        .await
        .unwrap();
    let metadata = f
        .core
        .handle
        .authorize_worker_metadata(&f.core.token, &f.parent.run.run_id, &b)
        .await
        .unwrap();
    let ready = f
        .core
        .handle
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: b.session_id,
                expected_generation: b.generation,
                native_session_id: "second-synthetic-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "second-worker-ready".into(),
            },
        )
        .await
        .unwrap();
    f.binding = ready.binding().clone();
    let run = candidate(&f).await;
    let second_cap = consume(&f, &run).await;
    assert_eq!(second_cap.text(), f.request.instructions);
    assert_ne!(second_cap.text(), first_text);
    assert_ne!(second_cap.provider().run.session_id, first_session);
    assert_eq!(statuses(&f).await.tasks.len(), 2);
    drop(second_cap);
    cleanup(f).await;
}

mod auth_tests;
mod durable_hold_tests;
mod payload_tests;
mod replay_tests;
