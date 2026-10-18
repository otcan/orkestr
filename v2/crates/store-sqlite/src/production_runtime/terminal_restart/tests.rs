use super::*;
use crate::production_runtime::{
    acceptance_tests::proposal,
    tests::{config, setup, snapshot},
};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clean_restart_preserves_history_and_dispatches_only_new_queued_input() {
    let f = setup().await;
    let (p, decision) = proposal(&f).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &decision)
        .await
        .unwrap();
    let predecessor = f.handle.supervisor_incarnation().unwrap().to_string();
    let restart = || {
        config(ProductionTakeover::ExpiredPredecessor {
            incarnation_id: predecessor.clone(),
        })
    };
    assert_eq!(
        f.store
            .terminal_supervisor_candidate(
                &f.token,
                &config(ProductionTakeover::First),
                &f.conversation
            )
            .await
            .unwrap(),
        None
    );
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.store
            .reattach_terminal_supervisor(&f.token, restart(), &p.run.run_id)
            .await,
        Err(RuntimeStoreError::Busy)
    ));
    assert_eq!(before, snapshot(&f.store).await);
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "after-restart".into(),
                text: "fresh queued input".into(),
            },
        )
        .await
        .unwrap();
    f.handle
        .retire_terminal_supervisor(&f.token, &p.run.run_id)
        .await
        .unwrap();
    let (new, grant) = f
        .store
        .reattach_terminal_supervisor(&f.token, restart(), &p.run.run_id)
        .await
        .unwrap();
    assert_ne!(new.supervisor_incarnation(), Some(predecessor.as_str()));
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
    let binding = grant.binding().clone();
    assert_eq!(binding.native_session_id, p.binding.native_session_id);
    assert!(matches!(
        f.handle.with_execution_fence(&p, || Ok::<_, ()>(())),
        Err(RuntimeStoreError::Fenced)
    ));
    assert!(matches!(
        f.store
            .reattach_terminal_supervisor(&f.token, restart(), &p.run.run_id)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(
        new.with_metadata_fence(&grant, || Ok::<_, ()>(1)).unwrap(),
        Ok(1)
    );
    let transition = new
        .confirm_metadata_session(
            grant,
            NativeSessionConfirmation {
                session_id: binding.session_id.clone(),
                expected_generation: binding.generation,
                native_session_id: binding.native_session_id.clone().unwrap(),
                protocol_version: "codex-resume-1".into(),
                source_event_key: "restart-ready".into(),
            },
        )
        .await
        .unwrap();
    let claim = new
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let admission = new
        .admit_run(&claim, &binding.session_id, binding.generation, "new-turn")
        .await
        .unwrap();
    assert_ne!(admission.provider.run.run_id, p.run.run_id);
    let DispatchClaimResult::Reserved(reservation) = new
        .claim_provider_dispatch(&admission, "new-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = new.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    transition.attach_execution(*cap).unwrap();
    assert_eq!(
        f.store
            .accept_execution_authenticated(&f.token, &f.conversation, &decision)
            .await
            .unwrap()
            .completion_event_id,
        decision.completion_event_id
    );
}

#[tokio::test]
async fn restart_refuses_unaccepted_unknown_revoked_and_wrong_predecessor_without_writes() {
    let f = setup().await;
    let (p, _) = proposal(&f).await;
    let predecessor = f.handle.supervisor_incarnation().unwrap().to_string();
    sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0")
        .execute(&f.store.pool)
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.store
            .reattach_terminal_supervisor(
                &f.token,
                config(ProductionTakeover::ExpiredPredecessor {
                    incarnation_id: predecessor.clone()
                }),
                &p.run.run_id
            )
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(before, snapshot(&f.store).await);
    assert!(matches!(
        f.store
            .reattach_terminal_supervisor(
                &f.token,
                config(ProductionTakeover::ExpiredPredecessor {
                    incarnation_id: "wrong".into()
                }),
                &p.run.run_id
            )
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(before, snapshot(&f.store).await);
    f.store.revoke_session(&f.token).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.store
            .reattach_terminal_supervisor(
                &f.token,
                config(ProductionTakeover::ExpiredPredecessor {
                    incarnation_id: predecessor
                }),
                &p.run.run_id
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(before, snapshot(&f.store).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_restart_has_one_winner_and_lost_setup_never_reissues() {
    let f = setup().await;
    let (p, decision) = proposal(&f).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &decision)
        .await
        .unwrap();
    let predecessor = f.handle.supervisor_incarnation().unwrap().to_string();
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    f.handle
        .retire_terminal_supervisor(&f.token, &p.run.run_id)
        .await
        .unwrap();
    let config = || {
        config(ProductionTakeover::ExpiredPredecessor {
            incarnation_id: predecessor.clone(),
        })
    };
    let (a, b) = tokio::join!(
        f.store
            .reattach_terminal_supervisor(&f.token, config(), &p.run.run_id),
        other.reattach_terminal_supervisor(&f.token, config(), &p.run.run_id)
    );
    let (winner, grant) = match (a, b) {
        (Ok(w), Err(RuntimeStoreError::Conflict)) | (Err(RuntimeStoreError::Conflict), Ok(w)) => w,
        _ => panic!("exactly one restart must win"),
    };
    let current = winner.supervisor_incarnation().unwrap().to_string();
    drop(grant);
    drop(winner);
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    assert!(matches!(
        reopened
            .reattach_terminal_supervisor(&f.token, config(), &p.run.run_id)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0")
        .execute(&reopened.pool)
        .await
        .unwrap();
    let before = snapshot(&reopened).await;
    assert!(matches!(
        reopened
            .reattach_terminal_supervisor(
                &f.token,
                super::super::tests::config(ProductionTakeover::ExpiredPredecessor {
                    incarnation_id: current
                }),
                &p.run.run_id
            )
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(before, snapshot(&reopened).await);
}
