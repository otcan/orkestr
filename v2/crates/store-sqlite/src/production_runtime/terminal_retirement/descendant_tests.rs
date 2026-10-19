use super::*;
use crate::production_runtime::{
    observation_tests::input,
    tests::{config, setup, snapshot, Case},
    worker::tests::running,
};
use orkestr_v2_contracts::ExecutionAcceptanceRequest;

pub(super) async fn child(f: &Case) -> (ProviderAdmission, Box<ConsumedProviderDispatch>) {
    let (parent, i) = running(f).await;
    let WorkerDelegationResult::Fresh(d) = f
        .handle
        .delegate_worker(&f.token, &parent.run.run_id, &i)
        .await
        .unwrap()
    else {
        panic!()
    };
    let run = f.handle.admit_worker(&f.token, d).await.unwrap();
    let DispatchClaimResult::Reserved(r) = f
        .handle
        .claim_provider_dispatch(&run, "worker-dispatch")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&r).await.unwrap() else {
        panic!()
    };
    f.handle
        .append_provider_event(
            &f.owner,
            cap.provider(),
            &input(cap.provider(), 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    (parent, cap)
}
pub(super) async fn accept(f: &Case, p: &ProviderAdmission) {
    let done = f
        .handle
        .append_provider_event(
            &f.owner,
            p,
            &input(p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(f.conversation.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    f.store
        .accept_execution_authenticated(
            &f.token,
            &f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: p.run.run_id.clone(),
                completion_event_id: done.event_id,
                expected_revision: revision,
                request_key: format!("accept:{}", p.run.run_id),
            },
        )
        .await
        .unwrap();
}
async fn stop(f: &Case, p: &ProviderAdmission) {
    let cancel = f
        .handle
        .request_cancel(&f.owner, &p.run.run_id, "child-stop")
        .await
        .unwrap();
    let mut control = p.clone();
    control.run = cancel.new_fenced_admission;
    f.handle
        .append_provider_event(
            &f.owner,
            &control,
            &input(&control, 2, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
}
async fn audit(f: &Case) -> Vec<String> {
    let mut rows = snapshot(&f.store).await;
    for table in [
        "worker_tasks",
        "worker_task_payloads",
        "worker_tool_delegations",
        "worker_tool_results",
    ] {
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
                .bind(table)
                .fetch_all(&f.store.pool)
                .await
                .unwrap();
        let fields = columns
            .iter()
            .map(|name| format!("'{name}',{name}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT json_object({fields}) FROM {table} ORDER BY 1");
        let values: Vec<String> = sqlx::query_scalar(&sql)
            .fetch_all(&f.store.pool)
            .await
            .unwrap();
        rows.push(format!("{table}:{values:?}"));
    }
    rows
}
pub(super) async fn refusal(f: &Case, p: &ProviderAdmission) {
    let before = audit(f).await;
    assert!(matches!(
        f.handle
            .retire_terminal_supervisor(&f.token, &p.run.run_id)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(audit(f).await, before);
}
fn restart(f: &Case) -> ProductionSupervisorConfig {
    config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
    })
}
#[tokio::test]
async fn accepted_or_stopped_worker_and_held_tasks_allow_parent_restart_without_task_replay() {
    for stopped in [false, true] {
        let f = setup().await;
        let (parent, cap) = child(&f).await;
        let revision: i64 =
            sqlx::query_scalar("SELECT revision FROM production_control_revisions WHERE run_id=?")
                .bind(parent.run.run_id.to_string())
                .fetch_one(&f.store.pool)
                .await
                .unwrap();
        let task = orkestr_v2_contracts::WorkerTaskCreateRequest {
            parent_run_id: parent.run.run_id.clone(),
            expected_control_revision: revision,
            request_key: "pending-owner-task".into(),
            title: "Synthetic task".into(),
            instructions: "Do not execute this held task".into(),
            lifetime_ms: 30_000,
            execution_budget_ms: None,
        };
        f.handle
            .create_worker_task_authenticated(&f.token, &f.conversation, &task)
            .await
            .unwrap();
        if stopped {
            stop(&f, cap.provider()).await;
        } else {
            accept(&f, cap.provider()).await;
        }
        accept(&f, &parent).await;
        let pending: (String, Option<String>) =
            sqlx::query_as("SELECT state,claim_hash FROM worker_tasks")
                .fetch_one(&f.store.pool)
                .await
                .unwrap();
        assert_eq!(pending, ("held".into(), None));
        f.handle
            .retire_terminal_supervisor(&f.token, &parent.run.run_id)
            .await
            .unwrap();
        let before = audit(&f).await;
        let (_next, grant) = f
            .store
            .reattach_terminal_supervisor(&f.token, restart(&f), &parent.run.run_id)
            .await
            .unwrap();
        assert_eq!(grant.binding().session_id, parent.run.session_id);
        let after = audit(&f).await;
        for table in [
            "worker_tasks",
            "worker_task_payloads",
            "worker_provider_delegations",
            "production_runs",
        ] {
            assert_eq!(
                before
                    .iter()
                    .filter(|r| r.starts_with(&format!("{table}:")))
                    .collect::<Vec<_>>(),
                after
                    .iter()
                    .filter(|r| r.starts_with(&format!("{table}:")))
                    .collect::<Vec<_>>()
            );
        }
    }
}
#[tokio::test]
async fn failed_unknown_unaccepted_or_unfinished_cancel_worker_never_qualifies() {
    for state in ["running", "failed", "proposal", "cancel"] {
        let f = setup().await;
        let (parent, cap) = child(&f).await;
        match state {
            "failed" => {
                f.handle
                    .append_provider_event(
                        &f.owner,
                        cap.provider(),
                        &input(cap.provider(), 2, ProviderEvent::Failed),
                    )
                    .await
                    .unwrap();
            }
            "proposal" => {
                f.handle
                    .append_provider_event(
                        &f.owner,
                        cap.provider(),
                        &input(
                            cap.provider(),
                            2,
                            ProviderEvent::CompletedProposal { synthetic: false },
                        ),
                    )
                    .await
                    .unwrap();
            }
            "cancel" => {
                f.handle
                    .request_cancel(&f.owner, &cap.provider().run.run_id, "ack-only")
                    .await
                    .unwrap();
            }
            _ => {}
        }
        stop(&f, &parent).await;
        refusal(&f, &parent).await;
    }
}
#[tokio::test]
async fn confirmed_setup_and_unadmitted_worker_do_not_prove_cleanup() {
    for delegated in [false, true] {
        let f = setup().await;
        let (parent, i) = running(&f).await;
        if delegated {
            let _ = f
                .handle
                .delegate_worker(&f.token, &parent.run.run_id, &i)
                .await
                .unwrap();
        }
        accept(&f, &parent).await;
        refusal(&f, &parent).await;
    }
}
async fn native(f: &Case, cap: &ConsumedProviderDispatch) -> ConsumedOfflinePython {
    let issuer = f
        .handle
        .authorize_offline_python_parent(&f.token, cap)
        .await
        .unwrap();
    let call = OfflinePythonNativeCall {
        request_id: OfflinePythonNativeRequestId::Integer(1),
        call_id: "call:1".into(),
        thread_id: cap.provider().run.native_session_id.clone().unwrap(),
        turn_id: "turn:1".into(),
    };
    let OfflinePythonAdmission::Fresh(d) = f
        .handle
        .delegate_native_offline_python(&f.token, &issuer, &call, "print(1)", 30_000)
        .await
        .unwrap()
    else {
        panic!()
    };
    let OfflinePythonConsumption::Launch(launch) =
        f.handle.consume_offline_python(&f.token, d).await.unwrap()
    else {
        panic!()
    };
    f.handle
        .with_offline_python_fence(&f.token, &launch, || Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
    launch
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_result_suffix_must_be_fully_committed_before_retirement_and_restart() {
    for phase in ["bound", "prepared", "unknown", "delivered"] {
        let f = setup().await;
        let (parent, cap) = child(&f).await;
        let launch = native(&f, &cap).await;
        if phase != "bound" {
            let OfflinePythonResultPreparation::Reserved(reservation) = f
                .handle
                .prepare_offline_python_result(
                    &f.token,
                    &launch,
                    &OfflinePythonOutput {
                        stdout: b"1\n".to_vec(),
                        stderr: vec![],
                        exit_code: Some(0),
                        signal: None,
                    },
                )
                .await
                .unwrap()
            else {
                panic!()
            };
            if phase != "prepared" {
                let OfflinePythonResultConsumption::Deliver(mut delivery) = f
                    .handle
                    .consume_offline_python_result(&f.token, reservation)
                    .await
                    .unwrap()
                else {
                    panic!()
                };
                if phase == "delivered" {
                    f.handle
                        .with_offline_python_result_fence(&f.token, &mut delivery, 0, 1, || {
                            Ok::<_, ()>(1)
                        })
                        .unwrap()
                        .unwrap();
                    f.handle
                        .finish_offline_python_result(&f.token, delivery, 1)
                        .await
                        .unwrap();
                }
            }
        }
        accept(&f, cap.provider()).await;
        accept(&f, &parent).await;
        if phase != "delivered" {
            refusal(&f, &parent).await;
            continue;
        }
        f.handle
            .retire_terminal_supervisor(&f.token, &parent.run.run_id)
            .await
            .unwrap();
        assert!(f
            .store
            .terminal_supervisor_candidate(
                &f.token,
                &config(ProductionTakeover::First),
                &f.conversation
            )
            .await
            .unwrap()
            .is_some());
        // A drifted/uncertain suffix cannot be ignored by read discovery or CAS.
        sqlx::query("UPDATE worker_tool_results SET state='delivery_unknown'")
            .execute(&f.store.pool)
            .await
            .unwrap();
        let before = audit(&f).await;
        assert!(f
            .store
            .terminal_supervisor_candidate(
                &f.token,
                &config(ProductionTakeover::First),
                &f.conversation
            )
            .await
            .unwrap()
            .is_none());
        assert!(f
            .store
            .reattach_terminal_supervisor(&f.token, restart(&f), &parent.run.run_id)
            .await
            .is_err());
        assert_eq!(audit(&f).await, before);
    }
}
