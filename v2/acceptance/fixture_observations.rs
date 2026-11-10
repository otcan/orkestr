//! Independently authored actual-store observation probes; synthetic data only.
use super::*;
use orkestr_v2_contracts::ConversationEvent;
use sqlx::{Connection, Row};

async fn consumed(c: &Case) -> ProviderAdmission {
    let fresh = c.admit(&c.h).await;
    let DispatchClaimResult::Reserved(claim) =
        c.h.claim_provider_dispatch(&fresh, "observation")
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

// One read-only transaction compares every column, including private values only
// in memory. Assertion output never formats these snapshots.
async fn snapshot(c: &Case) -> Vec<String> {
    let mut conn = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(c.path.join("test.sqlite3"))
            .read_only(true),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA query_only=ON")
        .execute(&mut conn)
        .await
        .unwrap();
    let mut tx = conn.begin().await.unwrap();
    let mut result = Vec::new();
    for table in [
        "conversations",
        "events",
        "outbox",
        "fixture_observations",
        "fixture_runs",
        "reasoning_inbox",
        "session_bindings",
    ] {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        let quoted = columns
            .iter()
            .map(|r| format!("quote(\"{}\")", r.get::<String, _>("name")))
            .collect::<Vec<_>>()
            .join(" || '|' || ");
        let rows: Vec<String> =
            sqlx::query_scalar(&format!("SELECT {quoted} FROM {table} ORDER BY rowid"))
                .fetch_all(&mut *tx)
                .await
                .unwrap();
        result.push(table.into());
        result.extend(rows);
    }
    tx.commit().await.unwrap();
    conn.close().await.unwrap();
    result
}

#[tokio::test]
async fn independent_observation_race_mixed_replay_and_takeover_receipt() {
    let c = Case::new().await;
    let p = consumed(&c).await;
    let second = c.h.reattach(&c.b).await.unwrap();
    let started = event(&p, 1, ProviderEvent::Started);
    let (a, b) = tokio::join!(
        c.h.append_provider_event(&c.claim.owner_id, &p, &started),
        second.append_provider_event(&c.claim.owner_id, &p, &started)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.event_id, b.event_id);
    assert_eq!(a.scope_sequence, b.scope_sequence);
    assert_ne!(a.duplicate, b.duplicate);
    let proposal = event(&p, 2, ProviderEvent::CompletedProposal { synthetic: false });
    let done =
        c.h.append_provider_event(&c.claim.owner_id, &p, &proposal)
            .await
            .unwrap();
    assert_eq!(done.state, RunState::AwaitingAcceptance);
    let rows =
        c.b.events(&c.claim.owner_id, &c.claim.conversation_id, 0, 100)
            .await
            .unwrap();
    assert_eq!(
        rows.iter()
            .map(ConversationEvent::sequence)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert!(matches!(&rows[0], ConversationEvent::MessageAccepted(_)));
    let ConversationEvent::FixtureProviderObserved(e) = &rows[2] else {
        panic!("metadata variant")
    };
    assert_eq!(e.source_event_id, c.claim.event_id);
    assert!(matches!(
        e.payload_ref_or_safe_payload.observation,
        orkestr_v2_contracts::FixtureObservationKind::CompletedProposal { synthetic: false }
    ));
    c.h.fixture_expire_context().await.unwrap();
    let successor = bootstrap_fixture_supervisor(
        &c.b,
        &c.claim.owner_id,
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
    let before = snapshot(&c).await;
    for h in [&c.h, &successor] {
        let replay = h
            .append_provider_event(&c.claim.owner_id, &p, &started)
            .await
            .unwrap();
        assert_eq!(replay.event_id, a.event_id);
        assert_eq!(replay.state, RunState::Running);
        assert!(replay.duplicate);
        assert_eq!(
            h.append_provider_event(&c.claim.owner_id, &p, &event(&p, 1, ProviderEvent::Stopped))
                .await
                .unwrap_err(),
            RuntimeStoreError::Conflict
        );
        assert!(h
            .append_provider_event(&c.claim.owner_id, &p, &event(&p, 3, ProviderEvent::Failed))
            .await
            .is_err());
    }
    assert!(
        before == snapshot(&c).await,
        "replay/refusal mutated durable rows"
    );
    c.close().await;
}

#[tokio::test]
async fn independent_observation_projection_failure_retries_without_gaps() {
    let c = Case::new().await;
    let p = consumed(&c).await;
    let mut conn = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(c.path.join("test.sqlite3")),
    )
    .await
    .unwrap();
    let input = event(&p, 1, ProviderEvent::Failed);
    for boundary in [
        "INSERT ON events",
        "INSERT ON fixture_observations",
        "INSERT ON outbox",
        "UPDATE OF state ON fixture_runs",
    ] {
        sqlx::query(&format!("CREATE TRIGGER independent_projection_failure BEFORE {boundary} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")).execute(&mut conn).await.unwrap();
        let before = snapshot(&c).await;
        assert_eq!(
            c.h.append_provider_event(&c.claim.owner_id, &p, &input)
                .await
                .unwrap_err(),
            RuntimeStoreError::Unavailable
        );
        assert!(
            before == snapshot(&c).await,
            "partial observation transaction"
        );
        sqlx::query("DROP TRIGGER independent_projection_failure")
            .execute(&mut conn)
            .await
            .unwrap();
    }
    conn.close().await.unwrap();
    let receipt =
        c.h.append_provider_event(&c.claim.owner_id, &p, &input)
            .await
            .unwrap();
    assert_eq!(receipt.sequence, 1);
    assert_eq!(receipt.scope_sequence, 2);
    assert_eq!(receipt.state, RunState::Failed);
    c.a.admit(
        &c.claim.owner_id,
        &c.claim.conversation_id,
        &MessageInput {
            client_message_id: "followup-observation".into(),
            text: "Synthetic next turn".into(),
        },
    )
    .await
    .unwrap();
    let claim =
        c.a.claim_next(
            &c.claim.owner_id,
            &c.claim.conversation_id,
            &c.binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let before = snapshot(&c).await;
    assert_eq!(
        c.h.admit_run(&claim, &c.binding.session_id, c.binding.generation, "next")
            .await
            .unwrap_err(),
        RuntimeStoreError::Busy
    );
    assert!(
        before == snapshot(&c).await,
        "Failed session reused or claim spent"
    );
    c.close().await;
}
