//! Parent proposals retain only exact existing child authority.
use super::completed_tests::{completed_worker, decision, running_worker, state};
use super::*;
use crate::production_runtime::{observation_tests::input as event, tests::setup};

#[tokio::test]
async fn completed_worker_retention_never_survives_parent_revocation_or_lineage_changes() {
    for change in ["cancel", "failed", "fence", "generation", "incarnation"] {
        let f = setup().await;
        let (parent, worker, completion) = completed_worker(&f).await;
        match change {
            "cancel" => {
                f.handle
                    .request_cancel(&f.owner, &parent.run.run_id, "parent-stop")
                    .await
                    .unwrap();
            }
            "failed" => {
                f.handle
                    .append_provider_event(
                        &f.owner,
                        &parent,
                        &event(&parent, 2, ProviderEvent::Failed),
                    )
                    .await
                    .unwrap();
            }
            column => {
                f.handle
                    .append_provider_event(
                        &f.owner,
                        &parent,
                        &event(
                            &parent,
                            2,
                            ProviderEvent::CompletedProposal { synthetic: false },
                        ),
                    )
                    .await
                    .unwrap();
                let update = match column {
                    "fence" => "UPDATE production_runs SET dispatch_fence=dispatch_fence+1 WHERE id=?",
                    "generation" => "UPDATE production_runs SET binding_generation=binding_generation+1 WHERE id=?",
                    _ => "UPDATE production_runs SET incarnation_id='changed' WHERE id=?",
                };
                sqlx::query(update)
                    .bind(parent.run.run_id.to_string())
                    .execute(&f.store.pool)
                    .await
                    .unwrap();
            }
        }
        assert_eq!(
            state(&f, &worker).await,
            ("blocked".into(), "lost".into(), "blocked".into()),
            "{change}"
        );
        let request = decision(&f, &worker, completion).await;
        assert!(f
            .store
            .accept_execution_authenticated(&f.token, &f.conversation, &request)
            .await
            .is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_running_child_rechecks_authority_and_canonical_parent_completion() {
    for change in ["auth", "binding", "completion", "supervisor", "expiry"] {
        let f = setup().await;
        let (parent, worker) = running_worker(&f).await;
        let completion = f
            .handle
            .append_provider_event(
                &f.owner,
                &parent,
                &event(
                    &parent,
                    2,
                    ProviderEvent::CompletedProposal { synthetic: false },
                ),
            )
            .await
            .unwrap()
            .event_id;
        match change {
            "auth" => {
                f.store.revoke_session(&f.token).await.unwrap();
            }
            "binding" => {
                sqlx::query("UPDATE session_bindings SET state='lost' WHERE id=?")
                    .bind(parent.run.session_id.to_string())
                    .execute(&f.store.pool)
                    .await
                    .unwrap();
            }
            "completion" => {
                sqlx::query("UPDATE events SET schema_version=8 WHERE id=?")
                    .bind(completion.to_string())
                    .execute(&f.store.pool)
                    .await
                    .unwrap();
            }
            "supervisor" => {
                sqlx::query("UPDATE production_supervisors SET incarnation_id='changed' WHERE context_id=(SELECT context_id FROM production_runs WHERE id=?)").bind(parent.run.run_id.to_string()).execute(&f.store.pool).await.unwrap();
            }
            _ => {
                sqlx::query("UPDATE worker_provider_delegations SET expires_at_ms=1 WHERE admitted_run_id=?").bind(worker.run.run_id.to_string()).execute(&f.store.pool).await.unwrap();
            }
        }
        let before = super::tests::ledger(&f.store).await;
        let mut calls = 0;
        assert!(
            f.handle
                .with_execution_fence(&worker, || {
                    calls += 1;
                    Ok::<_, ()>(())
                })
                .is_err(),
            "{change}"
        );
        assert_eq!(calls, 0);
        assert!(f
            .handle
            .append_provider_event(
                &f.owner,
                &worker,
                &event(&worker, 2, ProviderEvent::Progress("late".into()))
            )
            .await
            .is_err());
        assert_eq!(super::tests::ledger(&f.store).await, before);
    }
}

#[tokio::test]
async fn retained_proposal_cannot_reopen_parent_or_child_steering() {
    use orkestr_v2_contracts::{ExecutionControlRequest, ExecutionSteeringRequest};
    let f = setup().await;
    let (parent, worker, _) = completed_worker(&f).await;
    f.handle
        .append_provider_event(
            &f.owner,
            &parent,
            &event(
                &parent,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    for provider in [&parent, &worker] {
        let status = f
            .handle
            .execution_run_status(&f.token, &f.owner, &f.conversation, &provider.run.run_id)
            .await
            .unwrap()
            .unwrap();
        let request = ExecutionSteeringRequest {
            control: ExecutionControlRequest {
                run_id: provider.run.run_id.clone(),
                expected_revision: status.revision,
                expected_control_revision: status.control_revision,
                request_key: format!("late-steer:{}", provider.run.run_id),
            },
            text: "late input must not execute or queue".into(),
        };
        let before = super::tests::ledger(&f.store).await;
        assert!(matches!(
            f.handle
                .steer_execution_authenticated(&f.token, &f.conversation, &request, None)
                .await,
            Err(RuntimeStoreError::Fenced)
        ));
        assert_eq!(super::tests::ledger(&f.store).await, before);
    }
}
