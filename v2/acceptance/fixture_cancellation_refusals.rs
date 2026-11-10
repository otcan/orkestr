//! Failure injection and cancellation boundary refusals.
use super::*;
#[tokio::test]
async fn independent_cancel_and_stopped_rollback_no_sequence_hole() {
    let c = Case::new().await;
    let claim = reserve(&c).await;
    let p = &claim.provider;
    c.h.consume_provider_dispatch(&claim).await.unwrap();
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(c.path.join("test.sqlite3")),
    )
    .await
    .unwrap();
    for (table, operation) in [
        ("fixture_run_leases", "INSERT"),
        ("events", "INSERT"),
        ("fixture_cancellations", "INSERT"),
        ("outbox", "INSERT"),
        ("fixture_control_outbox", "INSERT"),
        ("fixture_runs", "UPDATE"),
    ] {
        sqlx::query(&format!("CREATE TRIGGER independent_cancel_failure BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT,'synthetic'); END")).execute(&mut db).await.unwrap();
        let before = rows(&c).await;
        assert_eq!(
            c.h.request_cancel(&p.run.owner_id, &p.run.run_id, "rollback")
                .await
                .unwrap_err(),
            RuntimeStoreError::Unavailable
        );
        assert!(before == rows(&c).await, "cancel partial write");
        sqlx::query("DROP TRIGGER independent_cancel_failure")
            .execute(&mut db)
            .await
            .unwrap();
    }
    let receipt =
        c.h.request_cancel(&p.run.owner_id, &p.run.run_id, "rollback")
            .await
            .unwrap();
    let ctrl = control(p, &receipt);
    for (table, operation) in [
        ("events", "INSERT"),
        ("fixture_observations", "INSERT"),
        ("outbox", "INSERT"),
        ("fixture_runs", "UPDATE"),
        ("fixture_control_outbox", "UPDATE"),
    ] {
        sqlx::query(&format!("CREATE TRIGGER independent_stop_failure BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT,'synthetic'); END")).execute(&mut db).await.unwrap();
        let before = rows(&c).await;
        assert_eq!(
            c.h.append_provider_event(
                &p.run.owner_id,
                &ctrl,
                &event(&ctrl, 1, ProviderEvent::Stopped)
            )
            .await
            .unwrap_err(),
            RuntimeStoreError::Unavailable
        );
        assert!(before == rows(&c).await, "stopped partial write");
        sqlx::query("DROP TRIGGER independent_stop_failure")
            .execute(&mut db)
            .await
            .unwrap();
    }
    db.close().await.unwrap();
    let r =
        c.h.append_provider_event(
            &p.run.owner_id,
            &ctrl,
            &event(&ctrl, 1, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
    assert_eq!((r.scope_sequence, r.sequence), (3, 1));
    c.close().await;
}
#[tokio::test]
async fn independent_cancel_terminal_owner_and_key_refusals() {
    for terminal in [
        ProviderEvent::Failed,
        ProviderEvent::Lost,
        ProviderEvent::CompletedProposal { synthetic: true },
    ] {
        let c = Case::new().await;
        let claim = reserve(&c).await;
        let p = &claim.provider;
        c.h.consume_provider_dispatch(&claim).await.unwrap();
        c.h.append_provider_event(&p.run.owner_id, p, &event(p, 1, ProviderEvent::Started))
            .await
            .unwrap();
        c.h.append_provider_event(&p.run.owner_id, p, &event(p, 2, terminal))
            .await
            .unwrap();
        let before = rows(&c).await;
        assert_eq!(
            c.h.request_cancel(&p.run.owner_id, &p.run.run_id, "terminal")
                .await
                .unwrap_err(),
            RuntimeStoreError::Fenced
        );
        assert!(before == rows(&c).await);
        c.close().await;
    }
    let c = Case::new().await;
    let fresh = c.admit(&c.h).await;
    let p = &fresh.provider;
    let before = rows(&c).await;
    let mut owner = p.run.owner_id.clone();
    owner.0 = p.run.run_id.0;
    assert_eq!(
        c.h.request_cancel(&owner, &p.run.run_id, "valid")
            .await
            .unwrap_err(),
        RuntimeStoreError::Unauthorized
    );
    for key in ["".to_owned(), "x".repeat(129), "has space".to_owned()] {
        assert_eq!(
            c.h.request_cancel(&p.run.owner_id, &p.run.run_id, &key)
                .await
                .unwrap_err(),
            RuntimeStoreError::InvalidInput
        );
    }
    assert!(before == rows(&c).await);
    c.h.request_cancel(&p.run.owner_id, &p.run.run_id, "valid")
        .await
        .unwrap();
    c.close().await;
}
#[tokio::test]
async fn independent_cancel_unrelated_context_and_expired_authority() {
    let c = Case::with_claim_duration(Duration::from_secs(1)).await;
    let fresh = c.admit(&c.h).await;
    let p = &fresh.provider;
    let other = bootstrap_fixture_supervisor(
        &c.b,
        &p.run.owner_id,
        ExplicitFixtureSupervisorConfig {
            namespace: "independent-unrelated".into(),
            supervisor_key: "other".into(),
            takeover: FixtureTakeover::First,
        },
    )
    .await
    .unwrap();
    let before = rows(&c).await;
    assert_eq!(
        other
            .request_cancel(&p.run.owner_id, &p.run.run_id, "cancel")
            .await
            .unwrap_err(),
        RuntimeStoreError::NotFound
    );
    assert!(before == rows(&c).await);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let before = rows(&c).await;
    assert_eq!(
        c.h.request_cancel(&p.run.owner_id, &p.run.run_id, "cancel")
            .await
            .unwrap_err(),
        RuntimeStoreError::Expired
    );
    assert!(before == rows(&c).await);
    other.validate_context().await.unwrap();
    c.close().await;
    let c = Case::new().await;
    let fresh = c.admit(&c.h).await;
    let p = &fresh.provider;
    c.h.fixture_expire_context().await.unwrap();
    let before = rows(&c).await;
    assert_eq!(
        c.h.request_cancel(&p.run.owner_id, &p.run.run_id, "cancel")
            .await
            .unwrap_err(),
        RuntimeStoreError::Expired
    );
    assert!(before == rows(&c).await);
    c.close().await;
}

#[tokio::test]
async fn independent_same_key_projects_do_not_alias_receipts() {
    let c = Case::new().await;
    let other = bootstrap_fixture_supervisor(
        &c.b,
        &c.claim.owner_id,
        ExplicitFixtureSupervisorConfig {
            namespace: "unrelated-projects".into(),
            supervisor_key: "other".into(),
            takeover: FixtureTakeover::First,
        },
    )
    .await
    .unwrap();
    let mut receipts = Vec::new();
    for key in ["cancel-project-a", "cancel-project-b"] {
        let (binding, claim) = super::super::negative::project_claim(&c, key, true).await;
        let fresh =
            c.h.admit_run(&claim, &binding.session_id, binding.generation, "run")
                .await
                .unwrap();
        let before = rows(&c).await;
        assert_eq!(
            other
                .request_cancel(&claim.owner_id, &fresh.provider.run.run_id, "same-key")
                .await
                .unwrap_err(),
            RuntimeStoreError::NotFound
        );
        assert!(before == rows(&c).await);
        let receipt =
            c.h.request_cancel(&claim.owner_id, &fresh.provider.run.run_id, "same-key")
                .await
                .unwrap();
        assert_eq!(
            receipt.new_fenced_admission.conversation_id,
            claim.conversation_id
        );
        receipts.push((fresh.provider, receipt));
    }
    assert_ne!(
        receipts[0].1.new_fenced_admission.run_id,
        receipts[1].1.new_fenced_admission.run_id
    );
    let before = rows(&c).await;
    for (provider, receipt) in receipts {
        assert_eq!(
            c.h.request_cancel(&provider.run.owner_id, &provider.run.run_id, "same-key")
                .await
                .unwrap(),
            receipt
        );
    }
    assert!(before == rows(&c).await);
    c.close().await;
}
