use super::observation_tests::{consumed, input};
use super::tests::setup;
use super::*;
use orkestr_v2_contracts::{ConversationId, ExecutionAcceptanceRequest};

#[tokio::test]
async fn accepted_history_is_scoped_removable_and_survives_reopen() {
    let f = setup().await;
    assert!(f
        .store
        .accepted_results_authenticated(&f.token, &f.conversation, 0, 20)
        .await
        .unwrap()
        .results
        .is_empty());
    let p = consumed(&f).await;
    for (sequence, event) in [
        (1, ProviderEvent::Started),
        (2, ProviderEvent::Progress("earlier output".into())),
        (3, ProviderEvent::Progress("exact accepted output".into())),
    ] {
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, sequence, event))
            .await
            .unwrap();
    }
    let done = f
        .handle
        .append_provider_event(
            &f.owner,
            &p,
            &input(&p, 4, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    let revision = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    let receipt = f
        .store
        .accept_execution_authenticated(
            &f.token,
            &f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: p.run.run_id.clone(),
                completion_event_id: done.event_id.clone(),
                expected_revision: revision,
                request_key: "history-accept".into(),
            },
        )
        .await
        .unwrap();
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let page = reopened
        .accepted_results_authenticated(&f.token, &f.conversation, 0, 1)
        .await
        .unwrap();
    assert!(page.is_valid());
    assert_eq!(page.results.len(), 1);
    assert!(page.next_after_sequence.is_none());
    let row = &page.results[0];
    assert_eq!(row.run_id, p.run.run_id);
    assert_eq!(row.completion_event_id, done.event_id);
    assert_eq!(row.acceptance_event_id, receipt.acceptance_event_id);
    let payload = row.payload_id.as_ref().unwrap();
    assert_eq!(
        reopened
            .provider_payload(&f.owner, &f.conversation, payload)
            .await
            .unwrap()
            .text
            .as_deref(),
        Some("exact accepted output")
    );
    assert!(reopened
        .accepted_results_authenticated(&f.token, &f.conversation, row.acceptance_sequence, 1)
        .await
        .unwrap()
        .results
        .is_empty());
    assert!(reopened
        .accepted_results_authenticated(&f.token, &ConversationId(Uuid::new_v4()), 0, 1)
        .await
        .is_err());
    assert!(reopened
        .accepted_results_authenticated(&f.token, &f.conversation, -1, 1)
        .await
        .is_err());
    assert!(reopened
        .accepted_results_authenticated(&f.token, &f.conversation, 0, 51)
        .await
        .is_err());
    reopened
        .remove_provider_payload(&f.owner, &f.conversation, payload)
        .await
        .unwrap();
    let removed = reopened
        .accepted_results_authenticated(&f.token, &f.conversation, 0, 1)
        .await
        .unwrap();
    assert_eq!(removed.results[0].payload_id, row.payload_id);
    assert!(removed.results[0].payload_removed);
    assert!(reopened
        .provider_payload(&f.owner, &f.conversation, payload)
        .await
        .unwrap()
        .text
        .is_none());
    reopened.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        reopened
            .accepted_results_authenticated(&f.token, &f.conversation, 0, 1)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
}

#[tokio::test]
async fn accepted_without_progress_has_no_invented_payload() {
    let f = setup().await;
    let (_, request) = super::acceptance_tests::proposal(&f).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    let row = f
        .store
        .accepted_results_authenticated(&f.token, &f.conversation, 0, 20)
        .await
        .unwrap()
        .results
        .remove(0);
    assert!(row.payload_id.is_none());
    assert!(!row.payload_removed);
}
