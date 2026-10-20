use super::*;

#[tokio::test]
async fn native_binding_is_atomic_exact_and_replays_metadata_only() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    let c = call(1);
    let g = grant(&f, &parent, &c).await;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM worker_tool_results WHERE delegation_id=? AND state='bound'",
    )
    .bind(g.id().to_string())
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    assert!(matches!(
        f.handle
            .delegate_native_offline_python(&f.token, &parent, &c, "print(1)", 5000)
            .await
            .unwrap(),
        OfflinePythonAdmission::Existing(_)
    ));
    assert!(matches!(
        f.handle
            .delegate_native_offline_python(&f.token, &parent, &c, "print(2)", 5000)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let mut changed = c.clone();
    changed.call_id = "another-call".into();
    assert!(matches!(
        f.handle
            .delegate_native_offline_python(&f.token, &parent, &changed, "print(1)", 5000)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    changed = c.clone();
    changed.request_id = OfflinePythonNativeRequestId::Text("1".into());
    assert!(matches!(
        f.handle
            .delegate_native_offline_python(&f.token, &parent, &changed, "print(1)", 5000)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    changed.call_id = "string-id".into();
    grant(&f, &parent, &changed).await;
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tool_delegations")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TRIGGER synthetic_fail_native_bind BEFORE INSERT ON worker_tool_results BEGIN SELECT RAISE(ABORT,'synthetic'); END").execute(&f.store.pool).await.unwrap();
    assert!(f
        .handle
        .delegate_native_offline_python(&f.token, &parent, &call(2), "print(1)", 5000)
        .await
        .is_err());
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tool_delegations")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(
        before, after,
        "failed correlation cannot leave a live orphan grant"
    );
    cleanup(f).await;
}

#[tokio::test]
async fn current_auth_native_scope_and_budgets_precede_replay() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    for mut bad in [call(0), call(1), call(2)] {
        if bad.call_id == "call:0" {
            // 0 is Codex's first server request id; beyond the JSON safe range is not.
            bad.request_id = OfflinePythonNativeRequestId::Integer(9_007_199_254_740_992);
        }
        if bad.call_id == "call:1" {
            bad.thread_id = "foreign".into();
        }
        if bad.call_id == "call:2" {
            bad.turn_id = "bad\n".into();
        }
        assert!(f
            .handle
            .delegate_native_offline_python(&f.token, &parent, &bad, "print(1)", 5000)
            .await
            .is_err());
    }
    for n in 1..=32 {
        grant(&f, &parent, &call(n)).await;
    }
    assert!(matches!(
        f.handle
            .delegate_native_offline_python(&f.token, &parent, &call(33), "print(1)", 5000)
            .await,
        Err(RuntimeStoreError::Busy)
    ));
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        f.handle
            .delegate_native_offline_python(&f.token, &parent, &call(1), "print(1)", 5000)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completion_requires_spent_launch_and_binds_full_output_not_rendered_prefix() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    let launch = launch(&f, grant(&f, &parent, &call(1)).await).await;
    assert!(matches!(
        f.handle
            .prepare_offline_python_result(&f.token, &launch, &output())
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    f.handle
        .with_offline_python_fence(&f.token, &launch, || Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
    let mut o = output();
    o.stdout = vec![b'x'; 16000];
    let OfflinePythonResultPreparation::Reserved(reservation) = f
        .handle
        .prepare_offline_python_result(&f.token, &launch, &o)
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(reservation.text.len() <= 8192);
    assert!(reservation.text.contains("truncated"));
    o.stdout[15999] = b'y';
    assert!(matches!(
        f.handle
            .prepare_offline_python_result(&f.token, &launch, &o)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let mut bad = output();
    bad.exit_code = None;
    assert!(matches!(
        f.handle
            .prepare_offline_python_result(&f.token, &launch, &bad)
            .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uncorrelated_legacy_completion_cannot_issue_native_result_authority() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    let OfflinePythonAdmission::Fresh(g) = f
        .handle
        .delegate_offline_python_from_parent(&f.token, &parent, "legacy", "print(1)", 5000)
        .await
        .unwrap()
    else {
        panic!()
    };
    let launch = launch(&f, g).await;
    f.handle
        .with_offline_python_fence(&f.token, &launch, || Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
    assert!(matches!(
        f.handle
            .prepare_offline_python_result(&f.token, &launch, &output())
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    cleanup(f).await;
}
