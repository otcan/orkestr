use super::*;
use orkestr_v2_contracts::{ConversationId, FastRunReceiptQuery, MessageId};

#[tokio::test]
async fn fast_run_receipt_binds_exact_input_window_native_and_actual_acceptance() {
    let w = Window::open().await;
    let binding = w.ready_fast().await;
    w.activate().await;
    let consumed = present(&w, &binding, &w.source).await;
    let query = FastRunReceiptQuery {
        input_message_id: w.source.input_message_id.clone(),
        input_event_id: w.source.input_event_id.clone(),
    };
    let before = fixtures::snapshot(&w.f.store).await;
    let proof =
        w.f.store
            .fast_run_receipt(&w.browser_credential, &w.f.owner, &w.f.conversation, &query)
            .await
            .unwrap();
    assert_eq!(proof.run_id, consumed.provider().run.run_id);
    assert_eq!(proof.session_id, binding.session_id);
    assert_eq!(
        proof.native_session_id,
        consumed.provider().run.native_session_id.clone().unwrap()
    );
    assert_eq!(proof.window_id, w.status.window_id);
    assert_eq!(proof.window_generation, 1);
    assert!(proof.acceptance_event_id.is_none());
    assert_ne!(proof.state, "succeeded");
    assert_eq!(fixtures::snapshot(&w.f.store).await, before);
    accept(&w, consumed.provider(), "Synthetic Fast acceptance").await;
    let proof =
        w.f.store
            .fast_run_receipt(&w.browser_credential, &w.f.owner, &w.f.conversation, &query)
            .await
            .unwrap();
    assert_eq!(proof.state, "succeeded");
    assert!(proof.acceptance_event_id.is_some());
}

#[tokio::test]
async fn fast_run_receipt_refuses_revoked_foreign_and_mismatched_input_without_writes() {
    let w = Window::open().await;
    let binding = w.ready_fast().await;
    w.activate().await;
    present(&w, &binding, &w.source).await;
    let query = FastRunReceiptQuery {
        input_message_id: w.source.input_message_id.clone(),
        input_event_id: w.source.input_event_id.clone(),
    };
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(w
        .f
        .store
        .fast_run_receipt("revoked", &w.f.owner, &w.f.conversation, &query)
        .await
        .is_err());
    assert!(w
        .f
        .store
        .fast_run_receipt(
            &w.browser_credential,
            &w.f.owner,
            &ConversationId(Uuid::new_v4()),
            &query
        )
        .await
        .is_err());
    let wrong = FastRunReceiptQuery {
        input_message_id: MessageId(Uuid::new_v4()),
        ..query
    };
    assert!(w
        .f
        .store
        .fast_run_receipt(&w.browser_credential, &w.f.owner, &w.f.conversation, &wrong)
        .await
        .is_err());
    assert_eq!(fixtures::snapshot(&w.f.store).await, before);
}
