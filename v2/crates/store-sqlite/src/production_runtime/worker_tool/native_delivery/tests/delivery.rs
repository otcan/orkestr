use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_deferred_commit_failure_after_bytes_poisoned_without_redelivery() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    let mut d = delivery(&f, &parent, 1).await;
    let id = d.delegation_id();
    sqlx::raw_sql("CREATE TABLE synthetic_commit_failure(marker TEXT REFERENCES owners(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_fail_result_commit AFTER UPDATE OF written_bytes ON worker_tool_results BEGIN INSERT INTO synthetic_commit_failure VALUES('missing-synthetic-owner'); END;")
        .execute(&f.store.pool).await.unwrap();
    let mut bytes = 0;
    assert!(f
        .handle
        .with_offline_python_result_fence(&f.token, &mut d, 0, 3, || {
            bytes += 3;
            Ok::<_, ()>(3)
        })
        .is_err());
    assert_eq!(bytes, 3);
    assert_eq!(state(&f, id).await, ("delivery_unknown".into(), 0));
    assert!(f
        .handle
        .with_offline_python_result_fence(
            &f.token,
            &mut d,
            0,
            3,
            || -> std::result::Result<usize, ()> { panic!("COMMIT uncertainty retry") }
        )
        .is_err());
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_effect_and_offer_bounds_poison_instead_of_accepting_counts() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    for (number, offered, returns, expected_calls) in [(1, 16385, 1, 0), (2, 3, 4, 1)] {
        let mut d = delivery(&f, &parent, number).await;
        let mut calls = 0;
        assert!(f
            .handle
            .with_offline_python_result_fence(&f.token, &mut d, 0, offered, || {
                calls += 1;
                Ok::<_, ()>(returns)
            })
            .is_err());
        assert_eq!(calls, expected_calls);
        assert!(f
            .handle
            .with_offline_python_result_fence(
                &f.token,
                &mut d,
                0,
                1,
                || -> std::result::Result<usize, ()> { panic!("invalid count retry") }
            )
            .is_err());
    }
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_consumer_wins_and_reopen_cannot_reissue_prepared_or_consumed_results() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    let (launch, reservation) = prepared(&f, &parent, 1).await;
    let duplicated = duplicate(&reservation);
    let second = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&second).await.unwrap();
    assert!(matches!(
        attached
            .prepare_offline_python_result(&f.token, &launch, &output())
            .await
            .unwrap(),
        OfflinePythonResultPreparation::ReconciliationRequired
    ));
    let (a, b) = tokio::join!(
        f.handle
            .consume_offline_python_result(&f.token, reservation),
        attached.consume_offline_python_result(&f.token, duplicated)
    );
    let delivery = match (a.unwrap(), b.unwrap()) {
        (
            OfflinePythonResultConsumption::Deliver(d),
            OfflinePythonResultConsumption::ReconciliationRequired,
        )
        | (
            OfflinePythonResultConsumption::ReconciliationRequired,
            OfflinePythonResultConsumption::Deliver(d),
        ) => d,
        _ => panic!("exactly one result consumer"),
    };
    assert_eq!(
        state(&f, delivery.delegation_id()).await,
        ("delivery_unknown".into(), 0)
    );
    drop(delivery); // Models lost response after durable consumption, before write.
    second.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&reopened).await.unwrap();
    assert!(matches!(
        attached
            .prepare_offline_python_result(&f.token, &launch, &output())
            .await
            .unwrap(),
        OfflinePythonResultPreparation::ReconciliationRequired
    ));
    assert!(matches!(
        attached
            .delegate_native_offline_python(&f.token, &parent, &call(1), "print(1)", 5000)
            .await
            .unwrap(),
        OfflinePythonAdmission::Existing(_)
    ));
    reopened.close().await;
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_successful_suffixes_commit_delivery_without_completing_worker() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    let mut d = delivery(&f, &parent, 1).await;
    let id = d.delegation_id();
    let before = crate::production_runtime::tests::snapshot(&f.store).await;
    assert_eq!(d.native_call().call_id, "call:1");
    assert_eq!(d.source_digest(), crate::digest("print(1)"));
    assert!(d.matches_source("print(1)"));
    assert!(!d.matches_source("print(2)"));
    assert!(!d.matches_source("print(1)\0"));
    assert!(!d.matches_source(&"x".repeat(32769)));
    assert!(d.success());
    assert!(d.text().contains("1\n"));
    assert_eq!(
        f.handle
            .with_offline_python_result_fence(&f.token, &mut d, 0, 8, || Ok::<_, ()>(0))
            .unwrap(),
        Ok(0)
    );
    assert_eq!(
        f.handle
            .with_offline_python_result_fence(&f.token, &mut d, 0, 8, || Ok::<_, ()>(3))
            .unwrap(),
        Ok(3)
    );
    assert_eq!(state(&f, id).await, ("delivery_unknown".into(), 3));
    assert_eq!(
        f.handle
            .with_offline_python_result_fence(&f.token, &mut d, 3, 5, || Ok::<_, ()>(5))
            .unwrap(),
        Ok(5)
    );
    f.handle
        .finish_offline_python_result(&f.token, d, 8)
        .await
        .unwrap();
    assert_eq!(state(&f, id).await, ("delivered".into(), 8));
    assert_eq!(
        before,
        crate::production_runtime::tests::snapshot(&f.store).await,
        "native result delivery never accepts a Worker or changes inbox ownership"
    );
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_error_and_repeated_offset_are_permanently_quarantined() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    for n in 1..=2 {
        let mut d = delivery(&f, &parent, n).await;
        let id = d.delegation_id();
        f.handle
            .with_offline_python_result_fence(&f.token, &mut d, 0, 8, || Ok::<_, ()>(3))
            .unwrap()
            .unwrap();
        let mut called = 0;
        if n == 1 {
            assert_eq!(
                f.handle
                    .with_offline_python_result_fence(&f.token, &mut d, 3, 5, || {
                        called += 1;
                        Err::<usize, _>("uncertain")
                    })
                    .unwrap(),
                Err("uncertain")
            );
            assert_eq!(called, 1);
        } else {
            assert!(f
                .handle
                .with_offline_python_result_fence(&f.token, &mut d, 0, 5, || {
                    called += 1;
                    Ok::<_, ()>(5)
                })
                .is_err());
            assert_eq!(called, 0);
        }
        assert!(f
            .handle
            .with_offline_python_result_fence(
                &f.token,
                &mut d,
                3,
                5,
                || -> std::result::Result<usize, ()> { panic!("poisoned retry") }
            )
            .is_err());
        assert!(f
            .handle
            .finish_offline_python_result(&f.token, d, 3)
            .await
            .is_err());
        assert_eq!(state(&f, id).await, ("delivery_unknown".into(), 3));
    }
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persistence_failure_after_actual_write_cannot_retry_or_claim_delivery() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    let mut d = delivery(&f, &parent, 1).await;
    let id = d.delegation_id();
    sqlx::raw_sql("CREATE TRIGGER synthetic_fail_result_count BEFORE UPDATE OF written_bytes ON worker_tool_results BEGIN SELECT RAISE(ABORT,'synthetic'); END").execute(&f.store.pool).await.unwrap();
    let mut bytes = Vec::new();
    assert!(f
        .handle
        .with_offline_python_result_fence(&f.token, &mut d, 0, 3, || {
            bytes.extend_from_slice(b"abc");
            Ok::<_, ()>(3)
        })
        .is_err());
    assert_eq!(bytes, b"abc");
    assert_eq!(
        state(&f, id).await,
        ("delivery_unknown".into(), 0),
        "durable consumption survives uncertain later persistence"
    );
    assert!(f
        .handle
        .with_offline_python_result_fence(
            &f.token,
            &mut d,
            0,
            3,
            || -> std::result::Result<usize, ()> { panic!("uncertain retry") }
        )
        .is_err());
    cleanup(f).await;
}
