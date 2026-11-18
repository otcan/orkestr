use super::observation_tests::{consumed, input};
use super::tests::setup;
use super::*;
use orkestr_v2_contracts::{ConversationId, ExecutionAcceptanceRequest};

#[tokio::test]
async fn every_update_is_listed_in_order_and_the_accepted_one_is_final() {
    let f = setup().await;
    let all = |store: &Store| {
        let (store, token, conversation) = (store.clone(), f.token.clone(), f.conversation.clone());
        async move {
            store
                .run_updates_authenticated(&token, &conversation, 0, 100)
                .await
                .unwrap()
        }
    };
    assert!(all(&f.store).await.updates.is_empty());
    let p = consumed(&f).await;
    for (sequence, event) in [
        (1, ProviderEvent::Started),
        (2, ProviderEvent::Progress("first synthetic update".into())),
        (3, ProviderEvent::Progress("second synthetic update".into())),
        (4, ProviderEvent::Progress("synthetic answer".into())),
    ] {
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, sequence, event))
            .await
            .unwrap();
    }
    // While the run works, every update is listed and none is final yet.
    let running = all(&f.store).await;
    assert!(running.is_valid());
    assert_eq!(running.updates.len(), 3);
    assert!(running
        .updates
        .iter()
        .all(|u| !u.final_answer && !u.payload_removed));
    assert!(running.updates.iter().all(|u| u.run_id == p.run.run_id));
    assert!(running.updates.iter().all(|u| u.observed_at_ms > 0));
    let mut texts = Vec::new();
    for update in &running.updates {
        texts.push(
            f.store
                .provider_payload(&f.owner, &f.conversation, &update.payload_id)
                .await
                .unwrap()
                .text
                .unwrap(),
        );
    }
    assert_eq!(
        texts,
        [
            "first synthetic update",
            "second synthetic update",
            "synthetic answer"
        ]
    );
    let done = f
        .handle
        .append_provider_event(
            &f.owner,
            &p,
            &input(&p, 5, ProviderEvent::CompletedProposal { synthetic: false }),
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
    f.store
        .accept_execution_authenticated(
            &f.token,
            &f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: p.run.run_id.clone(),
                completion_event_id: done.event_id.clone(),
                expected_revision: revision,
                request_key: "updates-accept".into(),
            },
        )
        .await
        .unwrap();
    // Accepted: the payload the accepted result names is the final answer.
    let accepted = all(&f.store).await;
    assert_eq!(
        accepted
            .updates
            .iter()
            .map(|u| u.final_answer)
            .collect::<Vec<_>>(),
        [false, false, true]
    );
    let result = f
        .store
        .accepted_results_authenticated(&f.token, &f.conversation, 0, 20)
        .await
        .unwrap();
    assert_eq!(
        result.results[0].payload_id.as_ref(),
        Some(&accepted.updates[2].payload_id)
    );
    // Forward pages carry a cursor; newest-first pages never do.
    let first = f
        .store
        .run_updates_authenticated(&f.token, &f.conversation, 0, 2)
        .await
        .unwrap();
    assert_eq!(first.updates, accepted.updates[..2]);
    assert_eq!(
        first.next_after_sequence,
        Some(accepted.updates[1].sequence)
    );
    let rest = f
        .store
        .run_updates_authenticated(&f.token, &f.conversation, accepted.updates[1].sequence, 2)
        .await
        .unwrap();
    assert_eq!(rest.updates, accepted.updates[2..]);
    assert!(rest.next_after_sequence.is_none());
    let newest = f
        .store
        .run_updates_before_authenticated(&f.token, &f.conversation, i64::MAX, 2)
        .await
        .unwrap();
    assert_eq!(newest.updates, accepted.updates[1..]);
    assert!(newest.next_after_sequence.is_none());
    let older = f
        .store
        .run_updates_before_authenticated(&f.token, &f.conversation, newest.updates[0].sequence, 2)
        .await
        .unwrap();
    assert_eq!(older.updates, accepted.updates[..1]);
    // Bounds, scope and session.
    for (after, limit) in [(-1, 10), (0, 0), (0, 101)] {
        assert!(f
            .store
            .run_updates_authenticated(&f.token, &f.conversation, after, limit)
            .await
            .is_err());
    }
    assert!(f
        .store
        .run_updates_before_authenticated(&f.token, &f.conversation, 0, 10)
        .await
        .is_err());
    assert!(f
        .store
        .run_updates_authenticated(&f.token, &ConversationId(Uuid::new_v4()), 0, 10)
        .await
        .is_err());
    // A removed text keeps its place, marked removed.
    f.store
        .remove_provider_payload(&f.owner, &f.conversation, &accepted.updates[0].payload_id)
        .await
        .unwrap();
    let removed = all(&f.store).await;
    assert!(removed.updates[0].payload_removed);
    assert_eq!(removed.updates[0].sequence, accepted.updates[0].sequence);
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        f.store
            .run_updates_authenticated(&f.token, &f.conversation, 0, 10)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
}
