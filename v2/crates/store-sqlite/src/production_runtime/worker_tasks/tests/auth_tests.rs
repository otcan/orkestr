use super::*;

#[tokio::test]
async fn current_browser_auth_and_exact_parent_control_precede_any_task_effect() {
    let mut f = fixture().await;
    let foreign = setup().await;
    let foreign_browser = format!("browser:{}", "cd".repeat(32));
    foreign
        .store
        .save_session(&foreign_browser, &foreign.owner)
        .await
        .unwrap();
    assert_eq!(
        foreign.store.authenticate(&foreign_browser).await.unwrap(),
        Some(foreign.owner.clone())
    );
    let before = audit(&f).await;
    assert!(matches!(
        f.core
            .handle
            .create_worker_task_authenticated(&foreign_browser, &f.core.conversation, &f.request)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.core
            .handle
            .create_worker_task_authenticated(
                &f.browser,
                &ConversationId(Uuid::new_v4()),
                &f.request
            )
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    f.request.expected_control_revision += 1;
    assert!(matches!(
        f.core
            .handle
            .create_worker_task_authenticated(&f.browser, &f.core.conversation, &f.request)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    f.request.expected_control_revision -= 1;
    f.request.parent_run_id = RunId(Uuid::new_v4());
    assert!(matches!(
        f.core
            .handle
            .create_worker_task_authenticated(&f.browser, &f.core.conversation, &f.request)
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    assert_eq!(audit(&f).await, before);
    f.request.parent_run_id = f.parent.run.run_id.clone();
    let receipt = create(&f).await;
    f.core.store.revoke_session(&f.browser).await.unwrap();
    let before = audit(&f).await;
    assert!(matches!(
        f.core
            .handle
            .create_worker_task_authenticated(&f.browser, &f.core.conversation, &f.request)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.core
            .handle
            .worker_tasks_authenticated(&f.browser, &f.core.conversation, &f.parent.run.run_id)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.core
            .handle
            .hold_worker_task_authenticated(&f.browser, &f.core.conversation, &receipt.task_id)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.core
            .handle
            .delete_worker_task_payload_authenticated(
                &f.browser,
                &f.core.conversation,
                &receipt.task_id
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(audit(&f).await, before);
    foreign.store.close().await;
    std::fs::remove_dir_all(foreign.root).unwrap();
    cleanup(f).await;
}

#[tokio::test]
async fn revoked_parent_keeps_historical_receipt_but_cannot_create_claim_or_delegate() {
    let mut f = fixture().await;
    let receipt = create(&f).await;
    let task = claim(&f).await;
    f.core.store.revoke_session(&f.core.token).await.unwrap();
    let before = audit(&f).await;
    assert_eq!(create(&f).await, receipt); // Evidence replay, current browser still authorized.
    assert_eq!(statuses(&f).await.tasks[0].phase, WorkerTaskPhase::Held);
    assert!(matches!(
        f.core
            .handle
            .claim_worker_task(&f.core.token, &f.parent.run.run_id)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.core
            .handle
            .delegate_worker_task(&f.core.token, task, &f.binding)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    f.request.request_key = "new-after-revoke".into();
    assert!(matches!(
        f.core
            .handle
            .create_worker_task_authenticated(&f.browser, &f.core.conversation, &f.request)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(audit(&f).await, before);
    cleanup(f).await;
}

#[tokio::test]
async fn stopped_parent_holds_queued_and_claimed_tasks_without_reissuing() {
    let mut f = fixture().await;
    create(&f).await;
    let claimed = claim(&f).await;
    f.request.request_key = "queued-at-stop".into();
    let queued = create(&f).await;
    f.core
        .handle
        .request_cancel(
            &f.core.owner,
            &f.parent.run.run_id,
            "stop-parent-with-tasks",
        )
        .await
        .unwrap();
    let before = audit(&f).await;
    assert!(statuses(&f)
        .await
        .tasks
        .iter()
        .all(|task| task.phase == WorkerTaskPhase::Held));
    assert_eq!(create(&f).await, queued);
    assert!(matches!(
        f.core
            .handle
            .claim_worker_task(&f.core.token, &f.parent.run.run_id)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert!(matches!(
        f.core
            .handle
            .delegate_worker_task(&f.core.token, claimed, &f.binding)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    f.request.request_key = "after-stop".into();
    assert!(matches!(
        f.core
            .handle
            .create_worker_task_authenticated(&f.browser, &f.core.conversation, &f.request)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(audit(&f).await, before);
    cleanup(f).await;
}

#[tokio::test]
async fn browser_data_and_receipts_never_authorize_claim_or_injected_provider_fields() {
    let f = fixture().await;
    let receipt = create(&f).await;
    let before = audit(&f).await;
    assert!(matches!(
        f.core
            .handle
            .claim_worker_task(&f.browser, &f.parent.run.run_id)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.core
            .handle
            .claim_worker_task(&receipt.task_id.to_string(), &f.parent.run.run_id)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    let mut json = serde_json::to_value(&f.request).unwrap();
    for field in [
        "owner_id",
        "provider_auth",
        "worker_binding_id",
        "source_message_id",
        "native_session_id",
    ] {
        json.as_object_mut()
            .unwrap()
            .insert(field.into(), "untrusted-value".into());
        assert!(serde_json::from_value::<WorkerTaskCreateRequest>(json.clone()).is_err());
        json.as_object_mut().unwrap().remove(field);
    }
    assert_eq!(audit(&f).await, before);
    cleanup(f).await;
}
