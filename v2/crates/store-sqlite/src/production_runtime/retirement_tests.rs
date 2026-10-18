use super::tests::{claim, ready, setup, snapshot};
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;

#[tokio::test]
async fn retirement_requires_revocation_and_preserves_unknown_queue_and_history() {
    for phase in 0..3 {
        let f = setup().await;
        let b = ready(&f).await;
        let c = claim(&f, &b).await;
        let run = f
            .handle
            .admit_run(&c, &b.session_id, b.generation, "retire-run")
            .await
            .unwrap();
        if phase > 0 {
            let DispatchClaimResult::Reserved(reservation) = f
                .handle
                .claim_provider_dispatch(&run, "reserve")
                .await
                .unwrap()
            else {
                panic!()
            };
            if phase == 2 {
                f.handle.consume_execution(&reservation).await.unwrap();
            }
        }
        f.store
            .admit(
                &f.owner,
                &f.conversation,
                &MessageInput {
                    client_message_id: "followup".into(),
                    text: "retained followup".into(),
                },
            )
            .await
            .unwrap();
        let before = snapshot(&f.store).await;
        assert!(matches!(
            f.handle.retire_revoked_supervisor().await,
            Err(RuntimeStoreError::Busy)
        ));
        assert!(matches!(
            f.store.retire_revoked_supervisor().await,
            Err(RuntimeStoreError::Unavailable)
        ));
        assert_eq!(snapshot(&f.store).await, before);
        let inbox: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT state,admitted_run_id FROM reasoning_inbox ORDER BY sequence")
                .fetch_all(&f.store.pool)
                .await
                .unwrap();
        f.store.revoke_session(&f.token).await.unwrap();
        assert_eq!(f.handle.retire_revoked_supervisor().await.unwrap(), 1);
        let row = sqlx::query("SELECT * FROM production_runs WHERE id=?")
            .bind(run.provider.run.run_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
        assert_eq!(row.get::<&str, _>("state"), "blocked");
        assert_eq!(
            row.get::<&str, _>("dispatch_state"),
            if phase == 2 {
                "delivery_unknown"
            } else {
                "quarantined"
            }
        );
        assert!(row.get::<Option<String>, _>("candidate_hash").is_none());
        assert!(row.get::<Option<String>, _>("reservation_hash").is_none());
        let after_inbox: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT state,admitted_run_id FROM reasoning_inbox ORDER BY sequence")
                .fetch_all(&f.store.pool)
                .await
                .unwrap();
        assert_eq!(inbox, after_inbox);
        let after = snapshot(&f.store).await;
        assert_eq!(f.handle.retire_revoked_supervisor().await.unwrap(), 0);
        assert_eq!(snapshot(&f.store).await, after);
        assert!(matches!(
            f.handle
                .append_provider_event(
                    &f.owner,
                    &run.provider,
                    &super::observation_tests::input(&run.provider, 1, ProviderEvent::Started)
                )
                .await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert_eq!(snapshot(&f.store).await, after);
    }
}

#[tokio::test]
async fn retirement_preserves_completion_and_rejects_obsolete_context() {
    let f = setup().await;
    let p = super::observation_tests::consumed(&f).await;
    for (sequence, event) in [
        (1, ProviderEvent::Started),
        (2, ProviderEvent::CompletedProposal { synthetic: false }),
    ] {
        f.handle
            .append_provider_event(
                &f.owner,
                &p,
                &super::observation_tests::input(&p, sequence, event),
            )
            .await
            .unwrap();
    }
    f.store.revoke_session(&f.token).await.unwrap();
    assert_eq!(f.handle.retire_revoked_supervisor().await.unwrap(), 0);
    let state: String = sqlx::query_scalar("SELECT state FROM production_runs WHERE id=?")
        .bind(p.run.run_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "awaiting_acceptance");
    let new_token = "cd".repeat(32);
    f.store.save_session(&new_token, &f.owner).await.unwrap();
    let successor = f
        .store
        .authorize_supervisor(
            &new_token,
            super::tests::config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
            }),
        )
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle.retire_revoked_supervisor().await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert!(matches!(
        successor.retire_revoked_supervisor().await,
        Err(RuntimeStoreError::Busy)
    ));
    assert_eq!(snapshot(&f.store).await, before);
}
