use super::descendant_tests::{accept, child, refusal};
use super::*;
use crate::production_runtime::{observation_tests::input, tests::setup};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_terminal_writers_allow_retirement_but_unspent_or_unknown_effects_do_not() {
    for state in ["delegated", "unknown", "completed", "failed", "cancelled"] {
        let f = setup().await;
        let (parent, cap) = child(&f).await;
        let OfflinePythonAdmission::Fresh(grant) = f
            .handle
            .delegate_offline_python(&f.token, &cap, "synthetic-tool", "print(1)", 30_000)
            .await
            .unwrap()
        else {
            panic!()
        };
        if state != "delegated" {
            let OfflinePythonConsumption::Launch(launch) = f
                .handle
                .consume_offline_python(&f.token, grant)
                .await
                .unwrap()
            else {
                panic!()
            };
            f.handle
                .with_offline_python_fence(&f.token, &launch, || Ok::<_, ()>(()))
                .unwrap()
                .unwrap();
            match state {
                "completed" | "failed" => {
                    let outcome = if state == "completed" {
                        OfflinePythonOutcome::Completed
                    } else {
                        OfflinePythonOutcome::Failed
                    };
                    f.handle
                        .finish_offline_python(&f.token, &launch, outcome, &"ab".repeat(32))
                        .await
                        .unwrap();
                }
                "cancelled" => {
                    let cancel = f
                        .handle
                        .request_cancel(&f.owner, &cap.provider().run.run_id, "tool-stop")
                        .await
                        .unwrap();
                    let mut control = cap.provider().clone();
                    control.run = cancel.new_fenced_admission;
                    f.handle
                        .acknowledge_offline_python_cancel(&f.token, &launch, &control)
                        .await
                        .unwrap();
                    f.handle
                        .append_provider_event(
                            &f.owner,
                            &control,
                            &input(&control, 2, ProviderEvent::Stopped),
                        )
                        .await
                        .unwrap();
                }
                _ => {}
            }
        }
        if state != "cancelled" {
            accept(&f, cap.provider()).await;
        }
        accept(&f, &parent).await;
        if matches!(state, "delegated" | "unknown") {
            refusal(&f, &parent).await;
        } else {
            f.handle
                .retire_terminal_supervisor(&f.token, &parent.run.run_id)
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn residual_pending_task_or_live_grant_refuses_without_rewriting_history() {
    let f = setup().await;
    let (parent, cap) = child(&f).await;
    let control: i64 =
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
                expected_control_revision: control,
                request_key: "held-task".into(),
                title: "Synthetic".into(),
                instructions: "Retain inertly".into(),
                lifetime_ms: 30_000,
                execution_budget_ms: None,
            },
        )
        .await
        .unwrap();
    accept(&f, cap.provider()).await;
    accept(&f, &parent).await;
    // Issuing-crate drift probes: the canonical parent writer already held this
    // task. Neither read discovery nor retirement may repair/reissue it silently.
    for claimed in [false, true] {
        sqlx::query("UPDATE worker_tasks SET state=?,claim_hash=?")
            .bind(if claimed { "claimed" } else { "queued" })
            .bind(if claimed { Some("cd".repeat(32)) } else { None })
            .execute(&f.store.pool)
            .await
            .unwrap();
        refusal(&f, &parent).await;
    }
    sqlx::query("UPDATE worker_tasks SET state='held',claim_hash=NULL")
        .execute(&f.store.pool)
        .await
        .unwrap();
    // An admitted child does not excuse a remaining delegated locator.
    sqlx::query("UPDATE worker_provider_delegations SET state='delegated',admitted_run_id=NULL,grant_hash=?")
        .bind("ef".repeat(32)).execute(&f.store.pool).await.unwrap();
    refusal(&f, &parent).await;
}
