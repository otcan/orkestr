//! Independently authored current-token CAS and immutable receipt checks.
use super::*;
use sqlx::{Connection, Row};

async fn rows(c: &Case) -> Vec<String> {
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(c.path.join("test.sqlite3"))
            .read_only(true),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA query_only=ON")
        .execute(&mut db)
        .await
        .unwrap();
    let mut tx = db.begin().await.unwrap();
    let mut all = Vec::new();
    for table in [
        "fixture_run_leases",
        "fixture_runs",
        "fixture_observations",
        "fixture_supervisors",
        "fixture_readiness",
        "conversations",
        "events",
        "outbox",
        "reasoning_inbox",
        "session_bindings",
    ] {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap()
            .iter()
            .map(|r| format!("\"{}\"", r.get::<String, _>("name")))
            .collect::<Vec<_>>()
            .join(",");
        all.push(table.into());
        let values: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT json_array({columns}) FROM {table} ORDER BY rowid"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        all.extend(values);
    }
    tx.commit().await.unwrap();
    db.close().await.unwrap();
    all
}
async fn dispatch(c: &Case) -> ProviderAdmission {
    let fresh = c.admit(&c.h).await;
    let DispatchClaimResult::Reserved(claim) =
        c.h.claim_provider_dispatch(&fresh, "renewal")
            .await
            .unwrap()
    else {
        panic!("reservation")
    };
    assert_eq!(
        c.h.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    claim.provider
}
fn event(p: &ProviderAdmission, sequence: u64, event: ProviderEvent) -> ProviderEventInput {
    ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        sequence,
        event,
    }
}

#[tokio::test]
async fn independent_renewal_race_history_reopen_and_historical_receipt() {
    let c = Case::with_claim_duration(Duration::from_secs(10)).await;
    let p = dispatch(&c).await;
    let original_event = event(&p, 1, ProviderEvent::Started);
    let original =
        c.h.append_provider_event(&p.run.owner_id, &p, &original_event)
            .await
            .unwrap();
    let observer = c.h.reattach(&c.b).await.unwrap();
    let (left, right) = tokio::join!(c.h.renew_lease(&p.run, 1), observer.renew_lease(&p.run, 1));
    let renewed = match (left, right) {
        (Ok(a), Err(RuntimeStoreError::StaleLease))
        | (Err(RuntimeStoreError::StaleLease), Ok(a)) => a,
        _ => panic!("exactly one current-generation winner"),
    };
    assert_eq!(renewed.lease_generation, 2);
    assert!(renewed.lease_deadline_ms > p.run.lease_deadline_ms);
    assert_eq!(renewed.dispatch_fence, p.run.dispatch_fence);
    // Refusals must preserve every column including historical token rows.
    let before = rows(&c).await;
    assert_eq!(
        observer.renew_lease(&p.run, 1).await.unwrap_err(),
        RuntimeStoreError::StaleLease
    );
    let mut forged = p.clone();
    forged.run.lease_deadline_ms += 1;
    assert_eq!(
        observer
            .append_provider_event(&p.run.owner_id, &forged, &original_event)
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert_eq!(
        observer
            .append_provider_event(&p.run.owner_id, &p, &event(&p, 2, ProviderEvent::Failed))
            .await
            .unwrap_err(),
        RuntimeStoreError::StaleLease
    );
    assert_eq!(
        observer
            .append_provider_event(&p.run.owner_id, &p, &event(&p, 1, ProviderEvent::Failed))
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert!(before == rows(&c).await, "refusal changed full snapshot");
    c.close().await;
    let reopened = Store::open(&c.path.join("test.sqlite3")).await.unwrap();
    let handle = c.h.reattach(&reopened).await.unwrap();
    assert!(before == rows(&c).await, "reopen changed history");
    let replay = handle
        .append_provider_event(&p.run.owner_id, &p, &original_event)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(
        (
            replay.event_id,
            replay.sequence,
            replay.scope_sequence,
            replay.state
        ),
        (
            original.event_id,
            1,
            original.scope_sequence,
            RunState::Running
        )
    );
    assert!(before == rows(&c).await, "committed replay mutated history");
    // The returned token remains usable after pool reopen; no new fake I/O.
    let mut active = p.clone();
    active.run = renewed;
    let receipt = handle
        .append_provider_event(
            &p.run.owner_id,
            &active,
            &event(&active, 2, ProviderEvent::Failed),
        )
        .await
        .unwrap();
    assert_eq!(
        (receipt.sequence, receipt.scope_sequence, receipt.state),
        (2, 3, RunState::Failed)
    );
    let terminal = rows(&c).await;
    assert_eq!(
        handle.renew_lease(&active.run, 2).await.unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert!(terminal == rows(&c).await);
    reopened.close().await;
}

#[tokio::test]
async fn independent_renewal_insert_failure_and_old_reservation_preserve_authority() {
    let c = Case::with_claim_duration(Duration::from_secs(10)).await;
    let fresh = c.admit(&c.h).await;
    let DispatchClaimResult::Reserved(mut claim) =
        c.h.claim_provider_dispatch(&fresh, "reservation")
            .await
            .unwrap()
    else {
        panic!("reservation")
    };
    let mut writer = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(c.path.join("test.sqlite3")),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER independent_renewal_failure BEFORE INSERT ON fixture_run_leases WHEN NEW.generation>1 BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        .execute(&mut writer).await.unwrap();
    let before = rows(&c).await;
    assert_eq!(
        c.h.renew_lease(&claim.provider.run, 1).await.unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    assert!(before == rows(&c).await, "failed renewal changed rows");
    sqlx::query("DROP TRIGGER independent_renewal_failure")
        .execute(&mut writer)
        .await
        .unwrap();
    writer.close().await.unwrap();
    let renewed = c.h.renew_lease(&claim.provider.run, 1).await.unwrap();
    let before = rows(&c).await;
    assert_eq!(
        c.h.consume_provider_dispatch(&claim).await.unwrap_err(),
        RuntimeStoreError::StaleLease
    );
    assert!(before == rows(&c).await, "old reservation spent authority");
    claim.provider.run = renewed;
    assert_eq!(
        c.h.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    assert_eq!(
        c.h.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::ReconciliationRequired
    );
    c.close().await;
}

#[tokio::test]
async fn independent_renewal_owner_purpose_and_generation_refusals_do_not_spend_token() {
    let c = Case::with_claim_duration(Duration::from_secs(10)).await;
    let p = dispatch(&c).await;
    let before = rows(&c).await;
    let mut owner = p.run.clone();
    owner.owner_id.0 = owner.conversation_id.0;
    assert_eq!(
        c.h.renew_lease(&owner, 1).await.unwrap_err(),
        RuntimeStoreError::Unauthorized
    );
    let mut control = p.run.clone();
    control.purpose = AdmissionPurpose::CancellationAcknowledgement;
    assert_eq!(
        c.h.renew_lease(&control, 1).await.unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert_eq!(
        c.h.renew_lease(&p.run, 0).await.unwrap_err(),
        RuntimeStoreError::InvalidInput
    );
    assert_eq!(
        c.h.renew_lease(&p.run, 2).await.unwrap_err(),
        RuntimeStoreError::StaleLease
    );
    assert!(
        before == rows(&c).await,
        "invalid request changed full snapshot"
    );
    let renewed = c.h.renew_lease(&p.run, 1).await.unwrap();
    assert_eq!(renewed.lease_generation, 2);
    c.close().await;
}
