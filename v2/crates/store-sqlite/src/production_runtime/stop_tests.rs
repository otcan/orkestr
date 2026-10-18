use super::tests::{claim, ready, setup, snapshot};
use super::*;
use orkestr_v2_contracts::{ConversationId, ExecutionControlRequest, ExecutionStopOutcome};
#[tokio::test]
async fn stop_revision_cas_and_request_replay_are_atomic_and_owner_scoped() {
    let f = setup().await;
    let b = ready(&f).await;
    let c = claim(&f, &b).await;
    let run = f
        .handle
        .admit_run(&c, &b.session_id, b.generation, "run")
        .await
        .unwrap();
    let revision = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    let mut input = ExecutionControlRequest {
        run_id: run.provider.run.run_id.clone(),
        expected_revision: revision - 1,
        request_key: "stop".into(),
    };
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .stop_execution(&f.owner, &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    input.expected_revision = revision;
    assert!(matches!(
        f.handle
            .stop_execution(&OwnerId(Uuid::new_v4()), &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.handle
            .stop_execution(&f.owner, &ConversationId(Uuid::new_v4()), &input)
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    assert!(matches!(
        f.store
            .stop_execution(&f.owner, &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&other).await.unwrap();
    let (a, b) = tokio::join!(
        f.handle.stop_execution(&f.owner, &f.conversation, &input),
        attached.stop_execution(&f.owner, &f.conversation, &input)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a, b);
    assert!(a.is_valid());
    let json = serde_json::to_value(&a).unwrap();
    assert_eq!(
        serde_json::from_value::<orkestr_v2_contracts::ExecutionStopReceipt>(json).unwrap(),
        a
    );
    assert!(
        serde_json::from_value::<ExecutionStopOutcome>(serde_json::json!("confirmed")).is_err()
    );
    assert_eq!(a.outcome, ExecutionStopOutcome::NotDispatched);
    assert!(a.revision > revision);
    let after = snapshot(&f.store).await;
    input.expected_revision = a.revision;
    assert!(matches!(
        f.handle
            .stop_execution(&f.owner, &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(snapshot(&f.store).await, after);
    input.expected_revision = revision;
    f.handle.heartbeat_supervisor().await.unwrap();
    let stable = snapshot(&f.store).await;
    assert_eq!(
        f.handle
            .stop_execution(&f.owner, &f.conversation, &input)
            .await
            .unwrap(),
        a
    );
    assert_eq!(snapshot(&f.store).await, stable);
}

#[tokio::test]
async fn authenticated_stop_checks_original_browser_credential_before_fresh_and_replay() {
    let f = setup().await;
    let b = ready(&f).await;
    let c = claim(&f, &b).await;
    let run = f
        .handle
        .admit_run(&c, &b.session_id, b.generation, "run")
        .await
        .unwrap();
    let input = ExecutionControlRequest {
        run_id: run.provider.run.run_id,
        expected_revision: f
            .store
            .execution_status(&f.owner, &f.conversation)
            .await
            .unwrap()
            .unwrap()
            .revision,
        request_key: "browser-stop".into(),
    };
    // Supervisor credential remains live; browser credential is separate.
    let browser = format!("browser:{}", "cd".repeat(32));
    f.store.save_session(&browser, &f.owner).await.unwrap();
    let cached = f.store.authenticate(&browser).await.unwrap().unwrap();
    f.store.revoke_session(&browser).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .stop_execution_guarded(&cached, &f.conversation, &input, Some(&browser))
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.handle
            .stop_execution_authenticated(&browser, &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    f.store.save_session(&browser, &f.owner).await.unwrap();
    let receipt = f
        .handle
        .stop_execution_authenticated(&browser, &f.conversation, &input)
        .await
        .unwrap();
    assert_eq!(
        f.handle
            .stop_execution_authenticated(&browser, &f.conversation, &input)
            .await
            .unwrap(),
        receipt
    );
    f.store.revoke_session(&browser).await.unwrap();
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&other).await.unwrap();
    let before = snapshot(&other).await;
    assert!(matches!(
        attached
            .stop_execution_guarded(&cached, &f.conversation, &input, Some(&browser))
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        attached
            .stop_execution_authenticated(&browser, &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&other).await, before);
    other.close().await;
}

#[cfg(feature = "fixture-test-controls")]
#[tokio::test]
async fn stop_public_authentication_checkpoint_refuses_logout_before_write_lock() {
    use std::time::Duration;
    let mut f = setup().await;
    let b = ready(&f).await;
    let c = claim(&f, &b).await;
    let run = f
        .handle
        .admit_run(&c, &b.session_id, b.generation, "run")
        .await
        .unwrap();
    let input = ExecutionControlRequest {
        run_id: run.provider.run.run_id,
        expected_revision: f
            .store
            .execution_status(&f.owner, &f.conversation)
            .await
            .unwrap()
            .unwrap()
            .revision,
        request_key: "browser-stop".into(),
    };
    let token = format!("browser:{}", "ef".repeat(32));
    f.store.save_session(&token, &f.owner).await.unwrap();
    let marker = f.root.join("stop-auth-checkpoint");
    f.handle
        .production_arm_checkpoint(
            crate::ProductionCheckpoint::StopAfterAuthentication,
            marker.clone(),
        )
        .await
        .unwrap();
    let writer = f.handle.clone();
    let conversation = f.conversation.clone();
    let credential = token.clone();
    let pending = tokio::spawn(async move {
        writer
            .stop_execution_authenticated(&credential, &conversation, &input)
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(&marker).unwrap(),
        b"stop-after-authentication"
    );
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    other.revoke_session(&token).await.unwrap();
    let before = snapshot(&other).await;
    std::fs::remove_file(&marker).unwrap();
    assert!(matches!(
        pending.await.unwrap(),
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&other).await, before);
    other.close().await;
}
