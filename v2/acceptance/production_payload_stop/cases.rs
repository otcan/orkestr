//! Independent public ordinary-store probes; snapshots never print verifier rows.
use super::*;
use orkestr_v2_contracts::{
    ConversationEvent, ExecutionControlRequest, ExecutionStopOutcome, ProductionObservationKind,
};
pub(super) const TOKEN: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
pub(super) fn event(
    p: &ProviderAdmission,
    sequence: u64,
    event: ProviderEvent,
) -> ProviderEventInput {
    ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        sequence,
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        event,
    }
}
pub(super) async fn active() -> (Case, Store, ProviderAdmission) {
    let c = Case::new().await;
    c.store.save_session(TOKEN, &c.owner).await.unwrap();
    let h = c.store.authorize_supervisor(TOKEN, config()).await.unwrap();
    let (b, claim) = c.ready_claim(&h).await;
    let run = h
        .admit_run(&claim, &b.session_id, b.generation, "independent-payload:1")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(r) =
        h.claim_provider_dispatch(&run, "dispatch:1").await.unwrap()
    else {
        panic!("fresh dispatch")
    };
    assert!(matches!(
        h.consume_execution(&r).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    h.append_provider_event(
        &c.owner,
        &run.provider,
        &event(&run.provider, 1, ProviderEvent::Started),
    )
    .await
    .unwrap();
    (c, h, run.provider)
}
#[tokio::test]
async fn removed_progress_replay_cannot_restore_text_or_mutate_any_ledger_row() {
    let (c, h, p) = active().await;
    let input = event(
        &p,
        2,
        ProviderEvent::Progress("synthetic <untrusted> 😀".into()),
    );
    let other = Store::open(&c.root.join("core.sqlite3")).await.unwrap();
    let attached = h.reattach_supervisor(&other).await.unwrap();
    let (a, b) = tokio::join!(
        h.append_provider_event(&c.owner, &p, &input),
        attached.append_provider_event(&c.owner, &p, &input)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.event_id, b.event_id);
    assert_ne!(a.duplicate, b.duplicate);
    let history = c
        .store
        .events(&c.owner, &c.conversation, 0, 100)
        .await
        .unwrap();
    let e = history
        .iter()
        .find(|e| e.sequence() == a.scope_sequence)
        .unwrap();
    let ConversationEvent::ProviderObserved(e) = e else {
        panic!("production event")
    };
    assert_eq!(e.schema_version, 8);
    assert!(e.is_valid());
    assert!(!serde_json::to_string(e).unwrap().contains("untrusted"));
    let ProductionObservationKind::ProgressRef { payload_id } =
        &e.payload_ref_or_safe_payload.observation
    else {
        panic!("reference")
    };
    let stable = oracle::rows(&c.root).await;
    for owner in [&OwnerId(Uuid::new_v4())] {
        assert!(c
            .store
            .provider_payload(owner, &c.conversation, payload_id)
            .await
            .is_err());
        assert!(c
            .store
            .remove_provider_payload(owner, &c.conversation, payload_id)
            .await
            .is_err());
    }
    assert!(
        oracle::rows(&c.root).await == stable,
        "foreign refusal changed ledger"
    );
    c.store
        .remove_provider_payload(&c.owner, &c.conversation, payload_id)
        .await
        .unwrap();
    let removed = oracle::rows(&c.root).await;
    let mut expected = stable;
    expected.get_mut("production_payloads").unwrap()[0]["text"] = serde_json::Value::Null;
    assert!(
        removed == expected,
        "removal must only tombstone payload text"
    );
    assert!(c
        .store
        .provider_payload(&c.owner, &c.conversation, payload_id)
        .await
        .unwrap()
        .text
        .is_none());
    let retry = attached
        .append_provider_event(&c.owner, &p, &input)
        .await
        .unwrap();
    assert_eq!(retry.event_id, a.event_id);
    assert_eq!(retry.scope_sequence, a.scope_sequence);
    assert!(retry.duplicate);
    let changed = event(&p, 2, ProviderEvent::Progress("changed".into()));
    assert!(matches!(
        h.append_provider_event(&c.owner, &p, &changed).await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert!(
        oracle::rows(&c.root).await == removed,
        "retry resurrected payload or changed ledger"
    );
    c.store.revoke_session(TOKEN).await.unwrap();
    assert!(matches!(
        h.append_provider_event(&c.owner, &p, &input).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(
        oracle::rows(&c.root).await == removed,
        "revoked replay changed ledger"
    );
}
#[tokio::test]
async fn stop_cas_refusals_and_late_replay_preserve_original_revision_receipt() {
    let (c, h, p) = active().await;
    let revision = c
        .store
        .execution_status(&c.owner, &c.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    let mut request = ExecutionControlRequest {
        run_id: p.run.run_id.clone(),
        expected_revision: revision - 1,
        request_key: "stop:independent".into(),
    };
    let before = oracle::rows(&c.root).await;
    assert!(matches!(
        h.stop_execution(&c.owner, &c.conversation, &request).await,
        Err(RuntimeStoreError::Conflict)
    ));
    request.expected_revision = revision;
    assert!(h
        .stop_execution(&OwnerId(Uuid::new_v4()), &c.conversation, &request)
        .await
        .is_err());
    assert!(h
        .stop_execution(&c.owner, &ConversationId(Uuid::new_v4()), &request)
        .await
        .is_err());
    assert!(matches!(
        c.store
            .stop_execution(&c.owner, &c.conversation, &request)
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert!(
        oracle::rows(&c.root).await == before,
        "refusals mutated ledger"
    );
    let other = Store::open(&c.root.join("core.sqlite3")).await.unwrap();
    let attached = h.reattach_supervisor(&other).await.unwrap();
    let (a, b) = tokio::join!(
        h.stop_execution(&c.owner, &c.conversation, &request),
        attached.stop_execution(&c.owner, &c.conversation, &request)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a, b);
    assert!(a.is_valid());
    assert_eq!(a.outcome, ExecutionStopOutcome::RequestedUnknown);
    let cancel = h
        .request_cancel(&c.owner, &p.run.run_id, &request.request_key)
        .await
        .unwrap();
    let mut control = p.clone();
    control.run = cancel.new_fenced_admission;
    h.append_provider_event(
        &c.owner,
        &control,
        &event(&control, 2, ProviderEvent::Stopped),
    )
    .await
    .unwrap();
    let stopped = oracle::rows(&c.root).await;
    assert_eq!(
        h.stop_execution(&c.owner, &c.conversation, &request)
            .await
            .unwrap(),
        a
    );
    request.expected_revision = a.revision;
    assert!(matches!(
        h.stop_execution(&c.owner, &c.conversation, &request).await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert!(
        oracle::rows(&c.root).await == stopped,
        "historical stop changed terminal ledger"
    );
}
