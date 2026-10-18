//! Authority refusals must preserve complete durable rows, not just row counts.
use super::dispatch_tests::{fixture, Fixture};
use super::*;
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::{ConversationId, EventId, MessageId, RunId, SessionId};

// All columns, including private verifiers, compared in memory without formatting
// snapshots into assertion output. One transaction gives a consistent before/after.
async fn snapshot(f: &Fixture) -> Vec<String> {
    let mut tx = f.b.pool.begin().await.unwrap();
    let mut result = Vec::new();
    for table in [
        "fixture_supervisors",
        "fixture_readiness",
        "fixture_runs",
        "fixture_observations",
        "reasoning_inbox",
        "session_bindings",
    ] {
        let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        let columns = rows
            .iter()
            .map(|r| format!("\"{}\"", r.get::<String, _>("name")))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT json_group_array(json_array({columns})) FROM (SELECT * FROM {table} ORDER BY rowid)");
        result.push(sqlx::query_scalar(&sql).fetch_one(&mut *tx).await.unwrap());
    }
    tx.commit().await.unwrap();
    result
}
fn unchanged(before: &[String], after: &[String], case: &str) {
    assert!(
        before == after,
        "durable authority changed on refusal: {case}"
    );
}

type Tamper = (&'static str, fn(&mut ProviderAdmission), RuntimeStoreError);
pub(super) fn provider_tampers() -> Vec<Tamper> {
    use RuntimeStoreError::*;
    vec![
        (
            "owner",
            |p| p.run.owner_id = OwnerId(Uuid::new_v4()),
            Unauthorized,
        ),
        (
            "conversation",
            |p| p.run.conversation_id = ConversationId(Uuid::new_v4()),
            Conflict,
        ),
        ("run", |p| p.run.run_id = RunId(Uuid::new_v4()), NotFound),
        (
            "session",
            |p| p.run.session_id = SessionId(Uuid::new_v4()),
            Conflict,
        ),
        ("role", |p| p.run.role = Role::Worker, Conflict),
        ("native", |p| p.run.native_session_id = None, Conflict),
        ("lease", |p| p.run.lease_generation += 1, StaleLease),
        ("fence", |p| p.run.dispatch_fence += 1, Fenced),
        ("attempt", |p| p.run.attempt += 1, Conflict),
        ("deadline", |p| p.run.lease_deadline_ms += 60_000, Conflict),
        (
            "purpose",
            |p| p.run.purpose = AdmissionPurpose::CancellationAcknowledgement,
            Conflict,
        ),
        (
            "binding owner",
            |p| p.binding.owner_id = OwnerId(Uuid::new_v4()),
            Conflict,
        ),
        (
            "binding conversation",
            |p| p.binding.conversation_id = ConversationId(Uuid::new_v4()),
            Conflict,
        ),
        (
            "binding session",
            |p| p.binding.session_id = SessionId(Uuid::new_v4()),
            Conflict,
        ),
        ("binding role", |p| p.binding.role = Role::Fast, Conflict),
        (
            "provider",
            |p| p.binding.provider_kind = ProviderKind::Codex,
            Conflict,
        ),
        (
            "binding native",
            |p| p.binding.native_session_id = Some("synthetic-alias".into()),
            Conflict,
        ),
        (
            "parent",
            |p| p.binding.parent_session_id = Some(SessionId(Uuid::new_v4())),
            Conflict,
        ),
        (
            "binding generation",
            |p| p.binding.generation += 1,
            Conflict,
        ),
        (
            "binding state",
            |p| p.binding.state = SessionState::Lost,
            Conflict,
        ),
    ]
}

#[tokio::test]
async fn reserve_and_consume_reject_tampering_without_spending_authority() {
    let f = fixture().await;
    let fresh = f.admit().await;
    let before = snapshot(&f).await;
    for (name, tamper, expected) in provider_tampers() {
        let mut forged = fresh.clone();
        tamper(&mut forged.provider);
        assert_eq!(
            f.handle
                .claim_provider_dispatch(&forged, "reserve1")
                .await
                .unwrap_err(),
            expected,
            "{name}"
        );
        unchanged(&before, &snapshot(&f).await, name);
    }
    for (name, key, expected) in [
        ("missing candidate", None, RuntimeStoreError::InvalidInput),
        (
            "malformed candidate",
            Some("short".into()),
            RuntimeStoreError::InvalidInput,
        ),
        (
            "wrong candidate",
            Some("0".repeat(64)),
            RuntimeStoreError::Conflict,
        ),
    ] {
        let mut forged = fresh.clone();
        forged.candidate_key = key;
        assert_eq!(
            f.handle
                .claim_provider_dispatch(&forged, "reserve1")
                .await
                .unwrap_err(),
            expected,
            "{name}"
        );
        unchanged(&before, &snapshot(&f).await, name);
    }
    let mut forged = fresh.clone();
    forged.run_state = RunState::Succeeded;
    assert_eq!(
        f.handle
            .claim_provider_dispatch(&forged, "reserve1")
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    unchanged(&before, &snapshot(&f).await, "terminal state");
    let mut replay = fresh.clone();
    replay.disposition = AdmissionDisposition::Replay;
    assert!(matches!(
        f.handle
            .claim_provider_dispatch(&replay, "reserve1")
            .await
            .unwrap(),
        DispatchClaimResult::Replay
    ));
    unchanged(&before, &snapshot(&f).await, "replayed candidate");
    let DispatchClaimResult::Reserved(claim) = f
        .handle
        .claim_provider_dispatch(&fresh, "reserve1")
        .await
        .unwrap()
    else {
        panic!("legitimate candidate survived refusals")
    };
    let before = snapshot(&f).await;
    for (name, tamper, expected) in provider_tampers() {
        let mut forged = (*claim).clone();
        tamper(&mut forged.provider);
        assert_eq!(
            f.handle
                .consume_provider_dispatch(&forged)
                .await
                .unwrap_err(),
            expected,
            "{name}"
        );
        unchanged(&before, &snapshot(&f).await, name);
    }
    for key in [String::new(), "z".repeat(64), "0".repeat(64)] {
        let mut forged = (*claim).clone();
        forged.reservation_key = key;
        assert_eq!(
            f.handle
                .consume_provider_dispatch(&forged)
                .await
                .unwrap_err(),
            RuntimeStoreError::Conflict
        );
        unchanged(&before, &snapshot(&f).await, "reservation verifier");
    }
    assert_eq!(
        f.handle
            .claim_provider_dispatch(&fresh, "changed-reserve-key")
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    unchanged(&before, &snapshot(&f).await, "changed reservation request");
    assert_eq!(
        f.handle.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    assert_eq!(
        f.handle.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::ReconciliationRequired
    );
    f.cleanup().await;
}

type ClaimTamper = (&'static str, fn(&mut InboxClaim), RuntimeStoreError);
#[tokio::test]
async fn admission_refusals_leave_claim_and_run_rows_exactly_intact() {
    let f = fixture().await;
    let cases: Vec<ClaimTamper> = vec![
        (
            "owner",
            |c| c.owner_id = OwnerId(Uuid::new_v4()),
            RuntimeStoreError::Unauthorized,
        ),
        (
            "conversation",
            |c| c.conversation_id = ConversationId(Uuid::new_v4()),
            RuntimeStoreError::NotFound,
        ),
        (
            "message",
            |c| c.message_id = MessageId(Uuid::new_v4()),
            RuntimeStoreError::StaleLease,
        ),
        (
            "event",
            |c| c.event_id = EventId(Uuid::new_v4()),
            RuntimeStoreError::StaleLease,
        ),
        (
            "consumer",
            |c| c.consumer_session_id = SessionId(Uuid::new_v4()),
            RuntimeStoreError::Conflict,
        ),
        (
            "sequence",
            |c| c.scope_sequence += 1,
            RuntimeStoreError::NotFound,
        ),
        (
            "generation",
            |c| c.claim_generation += 1,
            RuntimeStoreError::StaleLease,
        ),
        (
            "deadline",
            |c| c.lease_deadline_ms += 60_000,
            RuntimeStoreError::StaleLease,
        ),
    ];
    let before = snapshot(&f).await;
    for (name, tamper, expected) in cases {
        let mut claim = f.claim.clone();
        tamper(&mut claim);
        assert_eq!(
            f.handle
                .admit_run(&claim, &f.binding.session_id, f.binding.generation, "run1")
                .await
                .unwrap_err(),
            expected,
            "{name}"
        );
        unchanged(&before, &snapshot(&f).await, name);
    }
    assert_eq!(
        f.handle
            .admit_run(
                &f.claim,
                &f.binding.session_id,
                f.binding.generation + 1,
                "run1"
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::StaleLease
    );
    unchanged(&before, &snapshot(&f).await, "binding generation");
    assert_eq!(
        f.admit().await.disposition,
        AdmissionDisposition::FreshCandidate
    );
    f.cleanup().await;
}

#[tokio::test]
async fn missing_or_changed_readiness_cannot_spend_claim_candidate_or_reservation() {
    let f = fixture().await;
    // Test-only fixture damage is committed before the baseline snapshot. Refusal
    // must preserve that exact baseline; restoring it is not a public readiness API.
    sqlx::query("DELETE FROM fixture_readiness")
        .execute(&f.a.pool)
        .await
        .unwrap();
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .admit_run(
                &f.claim,
                &f.binding.session_id,
                f.binding.generation,
                "run1"
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    unchanged(&before, &snapshot(&f).await, "missing admission readiness");
    sqlx::query("INSERT INTO fixture_readiness(session_id,context_id,incarnation_id,protocol_version) VALUES(?,?,?,1)")
        .bind(f.binding.session_id.to_string()).bind(f.handle.context_id.to_string()).bind(f.handle.incarnation_id.to_string())
        .execute(&f.a.pool).await.unwrap();
    let fresh = f.admit().await;
    // Both reserve and consume must recheck durable readiness, even though the
    // supplied provider snapshot and opaque locator remain completely unchanged.
    for phase in ["candidate", "reserved"] {
        let reservation = if phase == "reserved" {
            let DispatchClaimResult::Reserved(c) = f
                .handle
                .claim_provider_dispatch(&fresh, "reserve1")
                .await
                .unwrap()
            else {
                panic!("candidate survives readiness refusals")
            };
            Some(c)
        } else {
            None
        };
        for (name, damage, restore) in [
            ("provider namespace", "UPDATE session_bindings SET provider_namespace='other-synthetic' WHERE role='deep'", "UPDATE session_bindings SET provider_namespace='explicit-fixture' WHERE role='deep'"),
            ("provider kind", "UPDATE session_bindings SET provider_kind='codex' WHERE role='deep'", "UPDATE session_bindings SET provider_kind='explicit_fixture' WHERE role='deep'"),
            ("binding state", "UPDATE session_bindings SET state='lost' WHERE role='deep'", "UPDATE session_bindings SET state='busy' WHERE role='deep'"),
            ("binding generation", "UPDATE session_bindings SET generation=generation+1 WHERE role='deep'", "UPDATE session_bindings SET generation=generation-1 WHERE role='deep'"),
            ("readiness incarnation", "UPDATE fixture_readiness SET incarnation_id='synthetic-other-incarnation'", ""),
        ] {
            sqlx::query(damage).execute(&f.a.pool).await.unwrap();
            let before = snapshot(&f).await;
            if let Some(c) = &reservation {
                assert_eq!(f.handle.consume_provider_dispatch(c).await.unwrap_err(), RuntimeStoreError::Fenced, "{name}");
            } else {
                assert_eq!(f.handle.claim_provider_dispatch(&fresh, "reserve1").await.unwrap_err(), RuntimeStoreError::Fenced, "{name}");
            }
            unchanged(&before, &snapshot(&f).await, name);
            if restore.is_empty() {
                sqlx::query("UPDATE fixture_readiness SET incarnation_id=?").bind(f.handle.incarnation_id.to_string()).execute(&f.a.pool).await.unwrap();
            } else {
                sqlx::query(restore).execute(&f.a.pool).await.unwrap();
            }
        }
        if let Some(c) = reservation {
            assert_eq!(
                f.handle.consume_provider_dispatch(&c).await.unwrap(),
                DispatchConsumption::DispatchNow
            );
        }
    }
    f.cleanup().await;
}

#[tokio::test]
async fn store_expired_run_lease_refuses_both_boundaries_without_consuming_verifiers() {
    let f = fixture().await;
    let fresh = f.admit().await;
    let deadline = fresh.provider.run.lease_deadline_ms;
    // Test-only damage makes the DURABLE lease expired; a matching caller
    // snapshot cannot bypass store time. No production renewal/setter is added.
    sqlx::query("UPDATE fixture_runs SET lease_deadline_ms=0")
        .execute(&f.a.pool)
        .await
        .unwrap();
    let mut expired = fresh.clone();
    expired.provider.run.lease_deadline_ms = 0;
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .claim_provider_dispatch(&expired, "reserve1")
            .await
            .unwrap_err(),
        RuntimeStoreError::Expired
    );
    unchanged(
        &before,
        &snapshot(&f).await,
        "durable candidate lease expiry",
    );
    sqlx::query("UPDATE fixture_runs SET lease_deadline_ms=?")
        .bind(deadline)
        .execute(&f.a.pool)
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(claim) = f
        .handle
        .claim_provider_dispatch(&fresh, "reserve1")
        .await
        .unwrap()
    else {
        panic!("refusal spent candidate")
    };
    sqlx::query("UPDATE fixture_runs SET lease_deadline_ms=0")
        .execute(&f.a.pool)
        .await
        .unwrap();
    let mut expired = (*claim).clone();
    expired.provider.run.lease_deadline_ms = 0;
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .consume_provider_dispatch(&expired)
            .await
            .unwrap_err(),
        RuntimeStoreError::Expired
    );
    unchanged(
        &before,
        &snapshot(&f).await,
        "durable reservation lease expiry",
    );
    sqlx::query("UPDATE fixture_runs SET lease_deadline_ms=?")
        .bind(deadline)
        .execute(&f.a.pool)
        .await
        .unwrap();
    assert_eq!(
        f.handle.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    f.cleanup().await;
}
