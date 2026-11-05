use super::*;
use orkestr_v2_application::{runtime::RuntimeStoreError, IntakeStore};
use orkestr_v2_contracts::{ExecutionWindowRequest, Receipt};

fn request(receipt: &Receipt, message: &MessageInput) -> ExecutionWindowRequest {
    ExecutionWindowRequest {
        request_key: format!("source-continuation:{}", receipt.event_id.0),
        input_message_id: receipt.message_id.clone(),
        input_event_id: receipt.event_id.clone(),
        input_request_key: message.client_message_id.clone(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    }
}

#[tokio::test]
async fn fresh_source_atomically_queues_once_and_normal_dispatch_consumes_intent() {
    let (f, _, message, query) = fixture().await;
    let admission = admit(&f, &message, &query).await.unwrap();
    assert!(admit(&f, &message, &query).await.unwrap().duplicate);
    let queue = f
        .store
        .execution_window_queue_authenticated(&f.token, Some(&f.conversation))
        .await
        .unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].input_message_id, admission.receipt.message_id);
    let input = request(&admission.receipt, &message);
    assert!(
        !f.store
            .admit_execution_window_authenticated(&f.token, &f.conversation, &input)
            .await
            .unwrap()
            .duplicate
    );
    assert!(f
        .store
        .execution_window_queue_authenticated(&f.token, Some(&f.conversation))
        .await
        .unwrap()
        .is_empty());
    assert!(
        f.store
            .admit_execution_window_authenticated(&f.token, &f.conversation, &input)
            .await
            .unwrap()
            .duplicate
    );
    close(f).await;
}

#[tokio::test]
async fn queued_source_rechecks_native_binding_and_retirement_before_dispatch() {
    let (f, source, message, query) = fixture().await;
    let admitted = admit(&f, &message, &query).await.unwrap();
    let input = request(&admitted.receipt, &message);
    for (change, restore) in [
        ("generation=generation+1", "generation=generation-1"),
        ("state='retired'", "state='busy'"),
        (
            "native_session_id='foreign-native'",
            "native_session_id='synthetic-native-deep'",
        ),
    ] {
        sqlx::query(&format!("UPDATE session_bindings SET {change} WHERE id=?"))
            .bind(source.run.session_id.to_string())
            .execute(&f.store.pool)
            .await
            .unwrap();
        assert!(matches!(
            f.store
                .admit_execution_window_authenticated(&f.token, &f.conversation, &input)
                .await,
            Err(RuntimeStoreError::Fenced)
        ));
        sqlx::query(&format!("UPDATE session_bindings SET {restore} WHERE id=?"))
            .bind(source.run.session_id.to_string())
            .execute(&f.store.pool)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO conversation_settings(conversation_id,owner_id,revision,provider,honor_no_reply,provider_generation,updated_at_ms) VALUES(?,?,1,'codex',1,1,0)")
        .bind(f.conversation.to_string()).bind(f.owner.to_string())
        .execute(&f.store.pool).await.unwrap();
    assert!(matches!(
        f.store
            .admit_execution_window_authenticated(&f.token, &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_windows")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    close(f).await;
}

#[tokio::test]
async fn legacy_replay_never_gains_continuation_intent_or_fences() {
    let (f, _, message, query) = fixture().await;
    f.store
        .admit(&f.owner, &f.conversation, &message)
        .await
        .unwrap();
    assert!(admit(&f, &message, &query).await.unwrap().duplicate);
    for table in ["execution_window_queue", "source_admission_fences"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    close(f).await;
}

#[tokio::test]
async fn queue_failure_rolls_back_message_and_source_fence() {
    let (f, _, message, query) = fixture().await;
    sqlx::query("CREATE TRIGGER synthetic_queue_failure BEFORE INSERT ON execution_window_queue BEGIN SELECT RAISE(ABORT,'synthetic full queue'); END")
        .execute(&f.store.pool).await.unwrap();
    assert!(matches!(
        admit(&f, &message, &query).await,
        Err(StoreError::Unavailable)
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE request_key=?")
        .bind(&message.client_message_id)
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM source_admission_fences")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    close(f).await;
}

#[tokio::test]
async fn source_storage_failure_keeps_window_intent_available_for_retry() {
    let (f, _, message, query) = fixture().await;
    let admitted = admit(&f, &message, &query).await.unwrap();
    let input = request(&admitted.receipt, &message);
    sqlx::query("ALTER TABLE source_admission_fences RENAME TO unavailable_source_fences")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .admit_execution_window_authenticated(&f.token, &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    let windows: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_windows")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(windows, 0);
    let queue = f
        .store
        .execution_window_queue_authenticated(&f.token, Some(&f.conversation))
        .await
        .unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].input_message_id, admitted.receipt.message_id);
    sqlx::query("ALTER TABLE unavailable_source_fences RENAME TO source_admission_fences")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(
        !f.store
            .admit_execution_window_authenticated(&f.token, &f.conversation, &input)
            .await
            .unwrap()
            .duplicate
    );
    close(f).await;
}

#[tokio::test]
async fn source_storage_failure_keeps_run_claim_unconsumed_for_retry() {
    use crate::production_runtime::tests::{claim, ready, snapshot};
    let root = std::env::temp_dir().join(format!("source-admission-retry-{}", Uuid::new_v4()));
    let f = setup_at(root).await;
    let binding = ready(&f).await;
    let claim = claim(&f, &binding).await;
    let before = snapshot(&f.store).await;
    sqlx::query("ALTER TABLE source_admission_fences RENAME TO unavailable_source_fences")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(matches!(
        f.handle
            .admit_run(
                &claim,
                &binding.session_id,
                binding.generation,
                "retry-source"
            )
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    sqlx::query("ALTER TABLE unavailable_source_fences RENAME TO source_admission_fences")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(snapshot(&f.store).await, before);
    assert_eq!(
        f.handle
            .admit_run(
                &claim,
                &binding.session_id,
                binding.generation,
                "retry-source"
            )
            .await
            .unwrap()
            .disposition,
        AdmissionDisposition::FreshCandidate
    );
    close(f).await;
}
