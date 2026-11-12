use super::observation_tests::{consumed, input};
use super::tests::{setup, snapshot};
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ConversationEvent, PayloadId, ProductionObservationKind};
#[tokio::test]
async fn progress_is_atomic_removable_and_replay_never_restores_text() {
    let f = setup().await;
    let p = consumed(&f).await;
    f.handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let progress = input(&p, 2, ProviderEvent::Progress("untrusted <text> 😀".into()));
    let second = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&second).await.unwrap();
    let (a, b) = tokio::join!(
        f.handle.append_provider_event(&f.owner, &p, &progress),
        attached.append_provider_event(&f.owner, &p, &progress)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.event_id, b.event_id);
    assert_ne!(a.duplicate, b.duplicate);
    let history = f
        .store
        .events(&f.owner, &f.conversation, 0, 100)
        .await
        .unwrap();
    let ConversationEvent::ProviderObserved(e) = &history[2] else {
        panic!()
    };
    assert_eq!(e.schema_version, 8);
    assert!(e.is_valid());
    let ProductionObservationKind::ProgressRef { payload_id } =
        &e.payload_ref_or_safe_payload.observation
    else {
        panic!()
    };
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&status.progress.as_ref().unwrap().payload_id, payload_id);
    assert!(status.is_valid());
    let encoded = serde_json::to_string(e).unwrap();
    assert!(!encoded.contains("untrusted"));
    assert_eq!(
        f.store
            .provider_payload(&f.owner, &f.conversation, payload_id)
            .await
            .unwrap()
            .text
            .as_deref(),
        Some("untrusted <text> 😀")
    );
    let before = snapshot(&f.store).await;
    assert!(f
        .store
        .remove_provider_payload(&OwnerId(Uuid::new_v4()), &f.conversation, payload_id)
        .await
        .is_err());
    assert_eq!(snapshot(&f.store).await, before);
    assert!(matches!(
        f.store
            .provider_payload(&f.owner, &f.conversation, &PayloadId(Uuid::new_v4()))
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    f.store
        .remove_provider_payload(&f.owner, &f.conversation, payload_id)
        .await
        .unwrap();
    f.store
        .remove_provider_payload(&f.owner, &f.conversation, payload_id)
        .await
        .unwrap();
    let tombstoned = snapshot(&f.store).await;
    let replay = attached
        .append_provider_event(&f.owner, &p, &progress)
        .await
        .unwrap();
    assert_eq!(replay.event_id, a.event_id);
    assert!(replay.duplicate);
    assert_eq!(snapshot(&f.store).await, tombstoned);
    assert!(second
        .provider_payload(&f.owner, &f.conversation, payload_id)
        .await
        .unwrap()
        .text
        .is_none());
    assert!(matches!(
        attached
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 2, ProviderEvent::Progress("changed".into()))
            )
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let done = attached
        .append_provider_event(
            &f.owner,
            &p,
            &input(&p, 3, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    assert_eq!(done.state, RunState::AwaitingAcceptance);
    let mut invalid = e.clone();
    invalid.schema_version = 5;
    assert!(!invalid.is_valid());
    assert!(
        serde_json::from_str::<ConversationEvent>(&serde_json::to_string(&invalid).unwrap())
            .is_err()
    );
}
#[tokio::test]
async fn progress_rollback_does_not_spend_event_sequence_or_payload() {
    let f = setup().await;
    let p = consumed(&f).await;
    f.handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TRIGGER reject_payload BEFORE INSERT ON production_payloads BEGIN SELECT RAISE(ABORT,'injected'); END;").execute(&f.store.pool).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 2, ProviderEvent::Progress("delta".into()))
            )
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    sqlx::raw_sql("DROP TRIGGER reject_payload")
        .execute(&f.store.pool)
        .await
        .unwrap();
    f.handle
        .append_provider_event(
            &f.owner,
            &p,
            &input(&p, 2, ProviderEvent::Progress("delta".into())),
        )
        .await
        .unwrap();
}
#[tokio::test]
async fn committed_progress_replay_survives_expiry_takeover_and_removal_but_new_progress_is_fenced()
{
    let f = setup().await;
    let p = consumed(&f).await;
    f.handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let delta = input(&p, 2, ProviderEvent::Progress("retained evidence".into()));
    let receipt = f
        .handle
        .append_provider_event(&f.owner, &p, &delta)
        .await
        .unwrap();
    let id: String = sqlx::query_scalar("SELECT id FROM production_payloads")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let id = PayloadId(id.parse().unwrap());
    f.store
        .remove_provider_payload(&f.owner, &f.conversation, &id)
        .await
        .unwrap();
    sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0")
        .execute(&f.store.pool)
        .await
        .unwrap();
    let successor = f
        .store
        .authorize_supervisor(
            &f.token,
            super::tests::config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
            }),
        )
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    assert_eq!(
        successor
            .append_provider_event(&f.owner, &p, &delta)
            .await
            .unwrap()
            .event_id,
        receipt.event_id
    );
    assert!(matches!(
        successor
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 3, ProviderEvent::Progress("new".into()))
            )
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    assert!(f
        .store
        .provider_payload(&f.owner, &f.conversation, &id)
        .await
        .unwrap()
        .text
        .is_none());
}
#[tokio::test]
async fn progress_byte_bounds_and_forged_envelope_do_not_spend_sequence() {
    let f = setup().await;
    let p = consumed(&f).await;
    f.handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 2, ProviderEvent::Progress("😀".repeat(2049)))
            )
            .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    let mut forged = p.clone();
    forged.run.lease_deadline_ms += 1;
    assert!(matches!(
        f.handle
            .append_provider_event(
                &f.owner,
                &forged,
                &input(&p, 2, ProviderEvent::Progress("delta".into()))
            )
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    f.handle
        .append_provider_event(
            &f.owner,
            &p,
            &input(&p, 2, ProviderEvent::Progress("😀".repeat(2048))),
        )
        .await
        .unwrap();
}
#[tokio::test]
async fn batch_read_is_scoped_ordered_bounded_and_keeps_removal() {
    let f = setup().await;
    let p = consumed(&f).await;
    for (sequence, event) in [
        (1, ProviderEvent::Started),
        (2, ProviderEvent::Progress("first synthetic answer".into())),
        (3, ProviderEvent::Progress("second synthetic answer".into())),
    ] {
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, sequence, event))
            .await
            .unwrap();
    }
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT p.id FROM production_payloads p JOIN production_observations o ON o.event_id=p.event_id ORDER BY o.run_sequence",
    )
    .fetch_all(&f.store.pool)
    .await
    .unwrap();
    let [first, second] = [&ids[0], &ids[1]].map(|id| PayloadId(id.parse().unwrap()));
    let unknown = PayloadId(Uuid::new_v4());
    // Requested order, unknown IDs left out, the same bytes as a single read.
    let read = f
        .store
        .provider_payloads(
            &f.owner,
            &f.conversation,
            &[second.clone(), unknown.clone(), first.clone()],
        )
        .await
        .unwrap();
    assert_eq!(
        read.iter()
            .map(|p| p.payload_id.clone())
            .collect::<Vec<_>>(),
        [second.clone(), first.clone()]
    );
    for payload in &read {
        let single = f
            .store
            .provider_payload(&f.owner, &f.conversation, &payload.payload_id)
            .await
            .unwrap();
        assert_eq!(payload.text, single.text);
        assert_eq!(payload.run_id, single.run_id);
        assert_eq!(payload.conversation_id, f.conversation);
    }
    assert_eq!(read[0].text.as_deref(), Some("second synthetic answer"));
    // Another owner or conversation reads nothing, exactly like a single read.
    assert!(matches!(
        f.store
            .provider_payloads(
                &OwnerId(Uuid::new_v4()),
                &f.conversation,
                std::slice::from_ref(&first)
            )
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    assert!(matches!(
        f.store
            .provider_payloads(
                &f.owner,
                &orkestr_v2_contracts::ConversationId(Uuid::new_v4()),
                std::slice::from_ref(&first)
            )
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    // Bounded: no empty or oversized batch.
    assert!(matches!(
        f.store
            .provider_payloads(&f.owner, &f.conversation, &[])
            .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    let many = vec![unknown.clone(); orkestr_v2_contracts::PROVIDER_PAYLOAD_BATCH + 1];
    assert!(matches!(
        f.store
            .provider_payloads(&f.owner, &f.conversation, &many)
            .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    // A removed payload stays removed in a batch.
    f.store
        .remove_provider_payload(&f.owner, &f.conversation, &first)
        .await
        .unwrap();
    let after = f
        .store
        .provider_payloads(&f.owner, &f.conversation, &[first.clone(), second.clone()])
        .await
        .unwrap();
    assert!(after[0].text.is_none());
    assert_eq!(after[1].text.as_deref(), Some("second synthetic answer"));
}
