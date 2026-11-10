//! Independent cancellation transaction acceptance; no provider I/O.
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
        "fixture_cancellations",
        "fixture_control_outbox",
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

async fn reserve(c: &Case) -> Box<DispatchClaim> {
    let fresh = c.admit(&c.h).await;
    match c
        .h
        .claim_provider_dispatch(&fresh, "cancel-reserve")
        .await
        .unwrap()
    {
        DispatchClaimResult::Reserved(r) => r,
        _ => panic!("fresh reservation"),
    }
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
fn control(p: &ProviderAdmission, r: &CancelReceipt) -> ProviderAdmission {
    ProviderAdmission {
        run: r.new_fenced_admission.clone(),
        binding: p.binding.clone(),
    }
}
#[tokio::test]
async fn independent_cancel_candidate_reserved_idempotency_reopen() {
    for reserved in [false, true] {
        let c = Case::new().await;
        let fresh = c.admit(&c.h).await;
        let claim = if reserved {
            Some(
                match c.h.claim_provider_dispatch(&fresh, "r").await.unwrap() {
                    DispatchClaimResult::Reserved(r) => r,
                    _ => panic!("reserve"),
                },
            )
        } else {
            None
        };
        let p = &fresh.provider;
        let other = c.h.reattach(&c.b).await.unwrap();
        let (a, b) = tokio::join!(
            c.h.request_cancel(&p.run.owner_id, &p.run.run_id, "cancel"),
            other.request_cancel(&p.run.owner_id, &p.run.run_id, "cancel")
        );
        let a = a.unwrap();
        let b = b.unwrap();
        assert_eq!(a, b);
        assert_eq!(
            (a.state, a.inflight_status),
            (RunState::Cancelled, InflightStatus::NotDispatched)
        );
        assert_eq!(
            a.new_fenced_admission.lease_generation,
            p.run.lease_generation + 1
        );
        assert_eq!(
            a.new_fenced_admission.dispatch_fence,
            p.run.dispatch_fence + 1
        );
        assert_eq!(
            a.new_fenced_admission.purpose,
            AdmissionPurpose::CancellationAcknowledgement
        );
        let before = rows(&c).await;
        assert!(c
            .h
            .claim_provider_dispatch(&fresh, "after-cancel")
            .await
            .is_err());
        assert_eq!(
            c.h.request_cancel(&p.run.owner_id, &p.run.run_id, "different")
                .await
                .unwrap_err(),
            RuntimeStoreError::Fenced
        );
        if let Some(claim) = claim {
            assert!(c.h.consume_provider_dispatch(&claim).await.is_err());
        }
        assert!(before == rows(&c).await);
        c.close().await;
        let store = Store::open(&c.path.join("test.sqlite3")).await.unwrap();
        let h = c.h.reattach(&store).await.unwrap();
        assert_eq!(
            h.request_cancel(&p.run.owner_id, &p.run.run_id, "cancel")
                .await
                .unwrap(),
            a
        );
        assert!(before == rows(&c).await);
        let events = store
            .events(&p.run.owner_id, &p.run.conversation_id, 0, 100)
            .await
            .unwrap();
        let wire = serde_json::to_value(events).unwrap();
        assert_eq!(wire.as_array().unwrap().len(), 2);
        assert_eq!(
            wire[1]["payload_ref_or_safe_payload"]["outcome"],
            "not_dispatched"
        );
        store.close().await;
    }
}
#[tokio::test]
async fn independent_consume_cancel_race_serializes_without_replacement() {
    for _ in 0..4 {
        let c = Case::new().await;
        let claim = reserve(&c).await;
        let other = c.h.reattach(&c.b).await.unwrap();
        let p = &claim.provider;
        let (consume, cancel) = tokio::join!(
            c.h.consume_provider_dispatch(&claim),
            other.request_cancel(&p.run.owner_id, &p.run.run_id, "race")
        );
        let cancel = cancel.unwrap();
        match consume {
            Ok(DispatchConsumption::DispatchNow) => assert_eq!(
                (cancel.state, cancel.inflight_status),
                (RunState::CancelRequested, InflightStatus::Unknown)
            ),
            Err(_) => assert_eq!(
                (cancel.state, cancel.inflight_status),
                (RunState::Cancelled, InflightStatus::NotDispatched)
            ),
            _ => panic!("one legal first consume"),
        }
        let before = rows(&c).await;
        assert!(!matches!(
            c.h.consume_provider_dispatch(&claim).await,
            Ok(DispatchConsumption::DispatchNow)
        ));
        assert!(before == rows(&c).await);
        c.close().await;
    }
}
#[tokio::test]
async fn independent_control_refusals_stopped_receipt_and_takeover() {
    let c = Case::new().await;
    let claim = reserve(&c).await;
    let p = &claim.provider;
    assert_eq!(
        c.h.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    let receipt =
        c.h.request_cancel(&p.run.owner_id, &p.run.run_id, "stop")
            .await
            .unwrap();
    assert_eq!(
        (receipt.state, receipt.inflight_status),
        (RunState::CancelRequested, InflightStatus::Unknown)
    );
    let ctrl = control(p, &receipt);
    let before = rows(&c).await;
    for (provider, kind) in [
        (p.clone(), ProviderEvent::Failed),
        (p.clone(), ProviderEvent::Stopped),
        (ctrl.clone(), ProviderEvent::Started),
    ] {
        assert!(c
            .h
            .append_provider_event(&p.run.owner_id, &provider, &event(&provider, 1, kind))
            .await
            .is_err());
        assert!(before == rows(&c).await);
    }
    assert_eq!(
        c.h.renew_lease(&ctrl.run, ctrl.run.lease_generation)
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    for field in 0..12 {
        let mut bad = ctrl.clone();
        match field {
            0 => bad.run.dispatch_fence += 1,
            1 => bad.run.lease_deadline_ms += 1,
            2 => bad.run.lease_generation += 1,
            3 => bad.run.purpose = AdmissionPurpose::Execution,
            4 => bad.run.role = Role::Worker,
            5 => bad.run.attempt += 1,
            6 => bad.binding.generation += 1,
            7 => bad.run.native_session_id = Some("synthetic-forged".into()),
            8 => bad.run.owner_id.0 = bad.run.run_id.0,
            9 => bad.run.session_id.0 = bad.run.run_id.0,
            10 => bad.run.run_id.0 = bad.run.session_id.0,
            _ => bad.run.conversation_id.0 = bad.run.run_id.0,
        }
        assert!(c
            .h
            .append_provider_event(
                &p.run.owner_id,
                &bad,
                &event(&bad, 1, ProviderEvent::Stopped)
            )
            .await
            .is_err());
        assert!(before == rows(&c).await);
    }
    let stopped = event(&ctrl, 1, ProviderEvent::Stopped);
    let original =
        c.h.append_provider_event(&p.run.owner_id, &ctrl, &stopped)
            .await
            .unwrap();
    assert_eq!(
        (original.sequence, original.scope_sequence, original.state),
        (1, 3, RunState::Cancelled)
    );
    c.close().await;
    let reopened = Store::open(&c.path.join("test.sqlite3")).await.unwrap();
    let handle = c.h.reattach(&reopened).await.unwrap();
    let same = handle
        .append_provider_event(&p.run.owner_id, &ctrl, &stopped)
        .await
        .unwrap();
    assert!(same.duplicate);
    assert_eq!(same.event_id, original.event_id);
    handle.fixture_expire_context().await.unwrap();
    let next = bootstrap_fixture_supervisor(
        &reopened,
        &p.run.owner_id,
        ExplicitFixtureSupervisorConfig {
            namespace: "independent".into(),
            supervisor_key: "transaction-check".into(),
            takeover: FixtureTakeover::ExpiredPredecessor {
                incarnation_id: c.h.incarnation_id(),
            },
        },
    )
    .await
    .unwrap();
    let before = rows(&c).await;
    assert_eq!(
        next.request_cancel(&p.run.owner_id, &p.run.run_id, "stop")
            .await
            .unwrap(),
        receipt
    );
    let replay = next
        .append_provider_event(&p.run.owner_id, &ctrl, &stopped)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.event_id, original.event_id);
    assert_eq!(replay.state, RunState::Cancelled);
    assert_eq!(
        next.append_provider_event(
            &p.run.owner_id,
            &ctrl,
            &event(&ctrl, 1, ProviderEvent::Failed)
        )
        .await
        .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert!(next
        .append_provider_event(
            &p.run.owner_id,
            &ctrl,
            &event(&ctrl, 2, ProviderEvent::Stopped)
        )
        .await
        .is_err());
    assert!(before == rows(&c).await);
    let wire = serde_json::to_value(
        reopened
            .events(&p.run.owner_id, &p.run.conversation_id, 0, 100)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(wire[1]["schema_version"], 3);
    assert_eq!(wire[1]["payload_ref_or_safe_payload"]["outcome"], "unknown");
    assert_eq!(wire[2]["schema_version"], 4);
    reopened.close().await;
}
#[path = "cancellation_refusals.rs"]
mod refusals;
