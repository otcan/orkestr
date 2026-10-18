use super::*;

#[tokio::test]
async fn deleted_raw_payload_never_falls_back_to_parent_text_at_consume() {
    let f = fixture().await;
    let receipt = create(&f).await;
    let run = candidate(&f).await;
    let reserved = reservation(&f, &run).await;
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
    assert!(matches!(
        f.core.handle.consume_execution(&reserved).await,
        Err(RuntimeStoreError::NotFound)
    ));
    assert_eq!(audit(&f).await, before); // No durable dispatch fence was consumed.
    assert_eq!(create(&f).await, receipt);
    assert_eq!(audit(&f).await, before); // Replay cannot restore the raw payload.
    cleanup(f).await;
}

#[tokio::test]
async fn payload_digest_mismatch_is_fenced_before_native_input_can_be_consumed() {
    let f = fixture().await;
    let receipt = create(&f).await;
    let run = candidate(&f).await;
    let reserved = reservation(&f, &run).await;
    // Fault injection into owned synthetic SQLite only: simulate payload corruption.
    sqlx::query(
        "UPDATE worker_task_payloads SET instructions='changed-after-claim' WHERE task_id=?",
    )
    .bind(receipt.task_id.to_string())
    .execute(&f.core.store.pool)
    .await
    .unwrap();
    let before = audit(&f).await;
    assert!(matches!(
        f.core.handle.consume_execution(&reserved).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(audit(&f).await, before);
    cleanup(f).await;
}

#[tokio::test]
async fn task_tag_without_atomic_mapping_cannot_use_legacy_parent_input() {
    let f = fixture().await;
    let input = WorkerAdmissionInput {
        worker_binding_id: f.binding.session_id.clone(),
        expected_binding_generation: f.binding.generation,
        source_message_id: MessageId(
            Uuid::parse_str(
                &sqlx::query_scalar::<_, String>(
                    "SELECT message_id FROM production_runs WHERE id=?",
                )
                .bind(f.parent.run.run_id.to_string())
                .fetch_one(&f.core.store.pool)
                .await
                .unwrap(),
            )
            .unwrap(),
        ),
        source_event_id: EventId(
            Uuid::parse_str(
                &sqlx::query_scalar::<_, String>("SELECT event_id FROM production_runs WHERE id=?")
                    .bind(f.parent.run.run_id.to_string())
                    .fetch_one(&f.core.store.pool)
                    .await
                    .unwrap(),
            )
            .unwrap(),
        ),
        request_key: "task:unlinked".into(),
        lifetime_ms: 30_000,
    };
    let WorkerDelegationResult::Fresh(grant) = f
        .core
        .handle
        .delegate_worker(&f.core.token, &f.parent.run.run_id, &input)
        .await
        .unwrap()
    else {
        panic!()
    };
    let run = f
        .core
        .handle
        .admit_worker(&f.core.token, grant)
        .await
        .unwrap();
    let reserved = reservation(&f, &run).await;
    let before = audit(&f).await;
    assert!(matches!(
        f.core.handle.consume_execution(&reserved).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(audit(&f).await, before);
    cleanup(f).await;
}

#[tokio::test]
async fn current_parent_revocation_also_refuses_already_reserved_task_dispatch() {
    let f = fixture().await;
    create(&f).await;
    let run = candidate(&f).await;
    let reserved = reservation(&f, &run).await;
    f.core.store.revoke_session(&f.core.token).await.unwrap();
    let before = audit(&f).await;
    assert!(matches!(
        f.core.handle.consume_execution(&reserved).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(statuses(&f).await.tasks[0].phase, WorkerTaskPhase::Held);
    assert_eq!(audit(&f).await, before);
    cleanup(f).await;
}
