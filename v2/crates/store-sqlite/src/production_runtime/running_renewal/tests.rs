use super::*;
use crate::production_runtime::observation_tests::input;
use crate::production_runtime::tests::{claim, ready, setup, snapshot, Case};
async fn consumed(f: &Case) -> Box<ConsumedProviderDispatch> {
    let b = ready(f).await;
    let c = claim(f, &b).await;
    let admitted = f
        .handle
        .admit_run(&c, &b.session_id, b.generation, "renew")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(r) = f
        .handle
        .claim_provider_dispatch(&admitted, "reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&r).await.unwrap() else {
        panic!()
    };
    cap
}
async fn extend(f: &Case) {
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    f.handle.heartbeat_supervisor().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_renewal_preserves_process_identity_and_historical_receipt_not_old_io() {
    let f = setup().await;
    let cap = consumed(&f).await;
    let old = cap.provider().clone();
    let mut authority = f.handle.authorize_running_renewal(&cap).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle.renew_running(&mut authority).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(before, snapshot(&f.store).await);
    let event = input(&old, 1, ProviderEvent::Started);
    let mut receipt = f
        .handle
        .append_provider_event(&f.owner, &old, &event)
        .await
        .unwrap();
    extend(&f).await;
    let transition = f.handle.renew_running(&mut authority).await.unwrap();
    assert_eq!(transition.previous(), &old);
    let current = transition.current();
    let mut expected = old.clone();
    expected.run.lease_generation += 1;
    expected.run.lease_deadline_ms = current.run.lease_deadline_ms;
    assert_eq!(current, &expected);
    assert!(current.run.lease_deadline_ms > old.run.lease_deadline_ms);
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle.with_execution_fence(&old, || Ok::<_, ()>(())),
        Err(RuntimeStoreError::StaleLease)
    ));
    assert_eq!(
        f.handle
            .with_execution_fence(current, || Ok::<_, ()>(()))
            .unwrap(),
        Ok(())
    );
    receipt.duplicate = true;
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &old, &event)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(snapshot(&f.store).await, before);
    f.handle
        .append_provider_event(
            &f.owner,
            current,
            &input(
                current,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle.renew_running(&mut authority).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
}
#[tokio::test]
async fn revoked_and_stale_renewal_refuse_without_mutating_authority_or_ledger() {
    let f = setup().await;
    let cap = consumed(&f).await;
    let mut a = f.handle.authorize_running_renewal(&cap).await.unwrap();
    let mut b = f.handle.authorize_running_renewal(&cap).await.unwrap();
    let p = cap.provider();
    f.handle
        .append_provider_event(&f.owner, p, &input(p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    extend(&f).await;
    f.handle.renew_running(&mut a).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle.renew_running(&mut b).await,
        Err(RuntimeStoreError::StaleLease)
    ));
    assert_eq!(b.provider, *p);
    assert_eq!(snapshot(&f.store).await, before);
    f.store.revoke_session(&f.token).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle.renew_running(&mut a).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&f.store).await, before);
}
#[tokio::test]
async fn parent_renewal_preserves_exact_delegation_lineage_without_extending_child() {
    let f = setup().await;
    let (p, i) = crate::production_runtime::worker::tests::running(&f).await;
    let WorkerDelegationResult::Fresh(d) = f
        .handle
        .delegate_worker(&f.token, &p.run.run_id, &i)
        .await
        .unwrap()
    else {
        panic!()
    };
    let child = f.handle.admit_worker(&f.token, d).await.unwrap();
    let DispatchClaimResult::Reserved(r) = f
        .handle
        .claim_provider_dispatch(&child, "child")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&r).await.unwrap() else {
        panic!()
    };
    let child_before = cap.provider().clone();
    // Private test only: production issuer requires the original consumed parent.
    let c = f.handle.context().unwrap();
    let mut a = RunRenewalAuthority {
        provider: p,
        namespace: c.namespace.clone(),
        incarnation: c.incarnation.clone(),
        worker_budget: None,
        renewed: false,
    };
    extend(&f).await;
    let renewed = f.handle.renew_running(&mut a).await.unwrap();
    assert_eq!(
        renewed.current().run.dispatch_fence,
        renewed.previous().run.dispatch_fence
    );
    f.handle
        .append_provider_event(
            &f.owner,
            &child_before,
            &input(&child_before, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let row = sqlx::query("SELECT * FROM worker_provider_delegations WHERE admitted_run_id=?")
        .bind(child_before.run.run_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(
        row.get::<i64, _>("parent_lease_generation"),
        renewed.current().run.lease_generation as i64
    );
    assert!(row.get::<i64, _>("expires_at_ms") <= renewed.previous().run.lease_deadline_ms);
}

#[tokio::test]
async fn pending_stop_and_natural_deadline_refuse_without_new_lease() {
    for stopping in [true, false] {
        let f = setup().await;
        let cap = consumed(&f).await;
        let p = cap.provider();
        let mut a = f.handle.authorize_running_renewal(&cap).await.unwrap();
        f.handle
            .append_provider_event(&f.owner, p, &input(p, 1, ProviderEvent::Started))
            .await
            .unwrap();
        if stopping {
            f.handle
                .request_cancel(&f.owner, &p.run.run_id, "stop")
                .await
                .unwrap();
        } else {
            // Author-only expiry oracle; public authority never accepts a clock setter.
            sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=1 WHERE context_id=?")
                .bind(&f.handle.context().unwrap().id)
                .execute(&f.store.pool)
                .await
                .unwrap();
        }
        let before = snapshot(&f.store).await;
        assert!(matches!(
            f.handle.renew_running(&mut a).await,
            Err(RuntimeStoreError::Fenced
                | RuntimeStoreError::Expired
                | RuntimeStoreError::StaleLease)
        ));
        assert_eq!(a.provider, *p);
        assert_eq!(snapshot(&f.store).await, before);
    }
}

#[tokio::test]
async fn independent_pool_renewal_has_one_generation_winner() {
    let f = setup().await;
    let cap = consumed(&f).await;
    let mut a = f.handle.authorize_running_renewal(&cap).await.unwrap();
    let mut b = f.handle.authorize_running_renewal(&cap).await.unwrap();
    let p = cap.provider();
    f.handle
        .append_provider_event(&f.owner, p, &input(p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let pool = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let other = f.handle.reattach_supervisor(&pool).await.unwrap();
    extend(&f).await;
    let (x, y) = tokio::join!(f.handle.renew_running(&mut a), other.renew_running(&mut b));
    assert!(matches!(
        (x, y),
        (Ok(_), Err(RuntimeStoreError::StaleLease)) | (Err(RuntimeStoreError::StaleLease), Ok(_))
    ));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM production_run_leases WHERE run_id=?")
            .bind(p.run.run_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(count, 2);
}
