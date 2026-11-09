use super::*;
use crate::production_runtime::tests::setup;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ConversationInput, MessageInput, QueuedWindowWithdrawal};
use std::sync::atomic::Ordering;

fn reset(store: &Store) {
    store
        .status_read_counts()
        .execution
        .store(0, Ordering::Relaxed);
    store
        .status_read_counts()
        .global_queue
        .store(0, Ordering::Relaxed);
    store
        .status_read_counts()
        .global_live
        .store(0, Ordering::Relaxed);
}

#[tokio::test]
async fn global_reads_are_once_per_batch_instead_of_once_per_conversation() {
    let f = setup().await;
    let mut conversations = vec![f.conversation.clone()];
    for index in 1..50 {
        conversations.push(
            f.store
                .create_conversation_authenticated(
                    &f.token,
                    &ConversationInput {
                        client_request_id: format!("status-batch-{index}"),
                        name: format!("Synthetic {index}"),
                    },
                )
                .await
                .unwrap()
                .0
                .conversation_id,
        );
    }
    // These are the same real global reads the old HTTP row loop performed.
    reset(&f.store);
    for _ in &conversations {
        f.store
            .execution_window_queue_authenticated(&f.token, None)
            .await
            .unwrap();
        f.store
            .live_execution_windows_authenticated(&f.token)
            .await
            .unwrap();
    }
    assert_eq!(
        f.store
            .status_read_counts()
            .global_queue
            .load(Ordering::Relaxed),
        50
    );
    assert_eq!(
        f.store
            .status_read_counts()
            .global_live
            .load(Ordering::Relaxed),
        50
    );
    for width in [1, 10, 50] {
        reset(&f.store);
        let rows = f
            .store
            .conversation_statuses_authenticated(&f.token, &f.owner, &conversations[..width], true)
            .await
            .unwrap();
        assert_eq!(rows.len(), width);
        assert!(rows.iter().all(|r| matches!(r.execution, Ok(None))));
        assert!(rows
            .iter()
            .all(|r| r.queue.as_ref().unwrap().as_ref().unwrap().queued_total == 0));
        assert_eq!(
            f.store
                .status_read_counts()
                .execution
                .load(Ordering::Relaxed),
            width
        );
        assert_eq!(
            f.store
                .status_read_counts()
                .global_queue
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            f.store
                .status_read_counts()
                .global_live
                .load(Ordering::Relaxed),
            1
        );
    }
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test]
async fn foreign_missing_revoked_and_bound_supervisor_reads_remain_scoped() {
    let f = setup().await;
    let stranger = OwnerId(Uuid::new_v4());
    // The product enforces one owner per database. A conversation id from a
    // different owner/host is absent here, not a reason to bypass singleton.
    let foreign = ConversationId(Uuid::new_v4());
    let ids = [
        f.conversation.clone(),
        foreign,
        ConversationId(Uuid::new_v4()),
    ];
    let rows = f
        .store
        .conversation_statuses_authenticated(&f.token, &f.owner, &ids, true)
        .await
        .unwrap();
    assert!(matches!(rows[0].execution, Ok(None)));
    for row in &rows[1..] {
        assert!(matches!(row.execution, Err(RuntimeStoreError::NotFound)));
        assert!(matches!(row.queue, Some(Err(RuntimeStoreError::NotFound))));
    }
    assert!(matches!(
        f.store
            .conversation_statuses_authenticated(&f.token, &stranger, &ids, true)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.handle
            .conversation_statuses_authenticated(&f.token, &f.owner, &ids, true)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        f.store
            .conversation_statuses_authenticated(&f.token, &f.owner, &ids, true)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test]
async fn window_credentials_cannot_gain_browser_queue_visibility() {
    let f = setup().await;
    crate::production_runtime::tests::ready(&f).await;
    let request = super::super::tests::input(&f, "status-window-credential").await;
    let window = f
        .store
        .admit_execution_window_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    let grant = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            window.status.window_id,
            window.status.generation,
            "synthetic-status-boot",
            window.status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    reset(&f.store);
    let rows = f
        .store
        .conversation_statuses_authenticated(
            grant.credential(),
            &f.owner,
            std::slice::from_ref(&f.conversation),
            true,
        )
        .await
        .unwrap();
    assert_eq!(
        rows[0].execution.as_ref().unwrap().as_ref().unwrap().phase,
        orkestr_v2_contracts::ExecutionPhase::Queued
    );
    assert!(matches!(
        rows[0].queue,
        Some(Err(RuntimeStoreError::Unauthorized))
    ));
    assert_eq!(
        f.store
            .status_read_counts()
            .global_queue
            .load(Ordering::Relaxed),
        0
    );
    assert_eq!(
        f.store
            .status_read_counts()
            .global_live
            .load(Ordering::Relaxed),
        0
    );
    assert!(matches!(
        f.store
            .execution_window_queue_authenticated(grant.credential(), Some(&f.conversation))
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test]
async fn each_snapshot_reads_current_queue_without_reusing_a_previous_result() {
    let f = setup().await;
    let before = f
        .store
        .conversation_statuses_authenticated(
            &f.token,
            &f.owner,
            std::slice::from_ref(&f.conversation),
            true,
        )
        .await
        .unwrap();
    assert_eq!(
        before[0]
            .queue
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()
            .queued_total,
        0
    );
    let receipt = f
        .store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "status-queued-input".into(),
                text: "Synthetic input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let request = ExecutionWindowRequest {
        request_key: "status-queued-window".into(),
        input_message_id: receipt.message_id,
        input_event_id: receipt.event_id,
        input_request_key: "status-queued-input".into(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    };
    let queued = f
        .store
        .enqueue_execution_window_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    let next = f
        .store
        .conversation_statuses_authenticated(
            &f.token,
            &f.owner,
            std::slice::from_ref(&f.conversation),
            true,
        )
        .await
        .unwrap();
    let queue = next[0].queue.as_ref().unwrap().as_ref().unwrap();
    assert_eq!(queue.queued_total, 1);
    assert_eq!(queue.entries, vec![queued]);
    f.store
        .withdraw_queued_execution_window_authenticated(
            &f.token,
            &f.conversation,
            &request.request_key,
            QueuedWindowWithdrawal::InputUnavailable,
        )
        .await
        .unwrap();
    let last = f
        .store
        .conversation_statuses_authenticated(
            &f.token,
            &f.owner,
            std::slice::from_ref(&f.conversation),
            true,
        )
        .await
        .unwrap();
    let queue = last[0].queue.as_ref().unwrap().as_ref().unwrap();
    assert_eq!(queue.queued_total, 0);
    assert!(queue.entries.is_empty());
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}
