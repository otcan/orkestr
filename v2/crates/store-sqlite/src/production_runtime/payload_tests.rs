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
