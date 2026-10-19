use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn separate_pool_claim_race_and_lost_reply_never_reissue() {
    let f = fixture().await;
    let receipt = create(&f).await;
    let reopened = Store::open(&f.core.root.join("core.sqlite3"))
        .await
        .unwrap();
    let other = f.core.handle.reattach_supervisor(&reopened).await.unwrap();
    let (one, two) = tokio::join!(
        f.core
            .handle
            .claim_worker_task(&f.core.token, &f.parent.run.run_id),
        other.claim_worker_task(&f.core.token, &f.parent.run.run_id)
    );
    let replies = [one.unwrap(), two.unwrap()];
    assert_eq!(replies.iter().filter(|r| r.is_some()).count(), 1);
    drop(replies); // Simulate lost claim delivery. No actor retains its private locator.
    let before = audit(&f).await;
    assert_eq!(create(&f).await, receipt);
    assert!(other
        .claim_worker_task(&f.core.token, &f.parent.run.run_id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(statuses(&f).await.tasks[0].phase, WorkerTaskPhase::Claimed);
    assert_eq!(audit(&f).await, before);
    f.core
        .handle
        .hold_worker_task_authenticated(&f.browser, &f.core.conversation, &receipt.task_id)
        .await
        .unwrap();
    assert_eq!(statuses(&f).await.tasks[0].phase, WorkerTaskPhase::Held);
    assert!(other
        .claim_worker_task(&f.core.token, &f.parent.run.run_id)
        .await
        .unwrap()
        .is_none());
    reopened.close().await;
    cleanup(f).await;
}

#[tokio::test]
async fn changed_idempotent_input_and_over_budget_create_leave_ledgers_unchanged() {
    let mut f = fixture().await;
    let receipt = create(&f).await;
    let original = f.request.clone();
    let before = audit(&f).await;
    for change in ["text", "title", "lifetime", "control"] {
        f.request = original.clone();
        match change {
            "text" => f.request.instructions.push('!'),
            "title" => f.request.title.push('!'),
            "lifetime" => f.request.lifetime_ms -= 1,
            _ => f.request.expected_control_revision += 1,
        }
        assert!(matches!(
            f.core
                .handle
                .create_worker_task_authenticated(&f.browser, &f.core.conversation, &f.request)
                .await,
            Err(RuntimeStoreError::Conflict)
        ));
        assert_eq!(audit(&f).await, before);
    }
    f.request = original;
    assert_eq!(create(&f).await, receipt);
    for index in 1..MAX_WORKER_TASKS_PER_PARENT {
        f.request.request_key = format!("bounded-task:{index}");
        create(&f).await;
    }
    assert_eq!(statuses(&f).await.tasks.len(), MAX_WORKER_TASKS_PER_PARENT);
    let before = audit(&f).await;
    f.request.request_key = "overflow".into();
    assert!(matches!(
        f.core
            .handle
            .create_worker_task_authenticated(&f.browser, &f.core.conversation, &f.request)
            .await,
        Err(RuntimeStoreError::Busy)
    ));
    assert_eq!(audit(&f).await, before);
    cleanup(f).await;
}

#[tokio::test]
async fn held_claim_and_deleted_payload_cannot_be_restored_by_create_replay() {
    let f = fixture().await;
    let receipt = create(&f).await;
    let claimed = claim(&f).await;
    f.core
        .handle
        .hold_worker_task_authenticated(&f.browser, &f.core.conversation, &receipt.task_id)
        .await
        .unwrap();
    let before = audit(&f).await;
    assert!(matches!(
        f.core
            .handle
            .delegate_worker_task(&f.core.token, claimed, &f.binding)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(audit(&f).await, before);
    f.core
        .handle
        .delete_worker_task_payload_authenticated(
            &f.browser,
            &f.core.conversation,
            &receipt.task_id,
        )
        .await
        .unwrap();
    let before = audit(&f).await;
    assert_eq!(create(&f).await, receipt);
    let list = statuses(&f).await;
    assert_eq!(list.tasks[0].phase, WorkerTaskPhase::Held);
    assert!(!list.tasks[0].instructions_available);
    assert!(list.tasks[0].title.is_none());
    assert!(f
        .core
        .handle
        .claim_worker_task(&f.core.token, &f.parent.run.run_id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(audit(&f).await, before);
    cleanup(f).await;
}

#[tokio::test]
async fn linking_failure_rolls_back_the_new_delegation_atomically() {
    let f = fixture().await;
    create(&f).await;
    let claimed = claim(&f).await;
    sqlx::query("CREATE TRIGGER synthetic_task_link_failure BEFORE UPDATE OF delegation_id ON worker_tasks WHEN NEW.delegation_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic link fault'); END")
        .execute(&f.core.store.pool).await.unwrap();
    let before = audit(&f).await;
    assert!(matches!(
        f.core
            .handle
            .delegate_worker_task(&f.core.token, claimed, &f.binding)
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert_eq!(audit(&f).await, before); // Includes the complete provider delegation ledger.
    assert_eq!(statuses(&f).await.tasks[0].phase, WorkerTaskPhase::Claimed);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_creates_cannot_exceed_the_last_parent_slot() {
    let mut f = fixture().await;
    for index in 0..MAX_WORKER_TASKS_PER_PARENT - 1 {
        f.request.request_key = format!("existing-task:{index}");
        create(&f).await;
    }
    let mut first = f.request.clone();
    first.request_key = "racing-create:one".into();
    let mut second = first.clone();
    second.request_key = "racing-create:two".into();
    let reopened = Store::open(&f.core.root.join("core.sqlite3"))
        .await
        .unwrap();
    let other = f.core.handle.reattach_supervisor(&reopened).await.unwrap();
    let (one, two) = tokio::join!(
        f.core
            .handle
            .create_worker_task_authenticated(&f.browser, &f.core.conversation, &first),
        other.create_worker_task_authenticated(&f.browser, &f.core.conversation, &second)
    );
    assert!(matches!(
        (one, two),
        (Ok(_), Err(RuntimeStoreError::Busy)) | (Err(RuntimeStoreError::Busy), Ok(_))
    ));
    assert_eq!(statuses(&f).await.tasks.len(), MAX_WORKER_TASKS_PER_PARENT);
    reopened.close().await;
    cleanup(f).await;
}
