use super::*;
use crate::production_runtime::{
    acceptance_tests::proposal,
    tests::{config, setup, snapshot},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn graceful_retirement_permits_immediate_exact_restart_without_clock_override() {
    let f = setup().await;
    let (p, decision) = proposal(&f).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &decision)
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    f.handle
        .retire_terminal_supervisor(&f.token, &p.run.run_id)
        .await
        .unwrap();
    f.handle
        .retire_terminal_supervisor(&f.token, &p.run.run_id)
        .await
        .unwrap();
    let after = snapshot(&f.store).await;
    assert_eq!(
        before
            .iter()
            .filter(|row| !row.starts_with("production_supervisors:"))
            .collect::<Vec<_>>(),
        after
            .iter()
            .filter(|row| !row.starts_with("production_supervisors:"))
            .collect::<Vec<_>>()
    );
    assert!(matches!(
        f.handle.with_execution_fence(&p, || Ok::<_, ()>(())),
        Err(RuntimeStoreError::Expired | RuntimeStoreError::Fenced)
    ));
    let restart = config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
    });
    let (next, grant) = f
        .store
        .reattach_terminal_supervisor(&f.token, restart, &p.run.run_id)
        .await
        .unwrap();
    assert_eq!(
        grant.binding().native_session_id,
        p.binding.native_session_id
    );
    assert_ne!(
        next.supervisor_incarnation(),
        f.handle.supervisor_incarnation()
    );
    assert!(matches!(
        f.handle
            .retire_terminal_supervisor(&f.token, &p.run.run_id)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retirement_refuses_unaccepted_wrong_run_and_revoked_original_without_writes() {
    let f = setup().await;
    let (p, decision) = proposal(&f).await;
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .retire_terminal_supervisor(&f.token, &p.run.run_id)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(before, snapshot(&f.store).await);
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &decision)
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .retire_terminal_supervisor(&f.token, &RunId(Uuid::new_v4()))
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert!(matches!(
        f.store
            .retire_terminal_supervisor(&f.token, &p.run.run_id)
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert!(matches!(
        f.handle
            .retire_terminal_supervisor(&"0".repeat(64), &p.run.run_id)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(before, snapshot(&f.store).await);
    f.store.revoke_session(&f.token).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .retire_terminal_supervisor(&f.token, &p.run.run_id)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(before, snapshot(&f.store).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_setup_and_retirement_cannot_both_issue_live_authority() {
    let f = setup().await;
    let (p, decision) = proposal(&f).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &decision)
        .await
        .unwrap();
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let pool = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let other = f.handle.reattach_supervisor(&pool).await.unwrap();
    let (retired, setup) = tokio::join!(
        f.handle.retire_terminal_supervisor(&f.token, &p.run.run_id),
        other.authorize_accepted_session_metadata(&f.token, &p.run.run_id, &binding)
    );
    assert_ne!(retired.is_ok(), setup.is_ok());
    match (retired, setup) {
        (Ok(()), Err(RuntimeStoreError::Expired)) => (),
        (Err(RuntimeStoreError::Fenced), Ok(grant)) => {
            assert_eq!(
                other
                    .with_metadata_fence(&grant, || Ok::<_, ()>(1))
                    .unwrap(),
                Ok(1)
            );
            let before = snapshot(&f.store).await;
            assert!(matches!(
                f.handle
                    .retire_terminal_supervisor(&f.token, &p.run.run_id)
                    .await,
                Err(RuntimeStoreError::Fenced)
            ));
            assert_eq!(before, snapshot(&f.store).await);
        }
        _ => panic!("unexpected retirement/setup race result"),
    }
}
