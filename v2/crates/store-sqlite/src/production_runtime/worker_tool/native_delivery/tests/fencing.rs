use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_between_successful_suffixes_refuses_the_next_actual_write() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    let mut d = delivery(&f, &parent, 1).await;
    let id = d.delegation_id();
    let mut bytes = Vec::new();
    f.handle
        .with_offline_python_result_fence(&f.token, &mut d, 0, 3, || {
            bytes.extend_from_slice(b"abc");
            Ok::<_, ()>(3)
        })
        .unwrap()
        .unwrap();
    f.handle
        .request_cancel(&f.owner, &d.parent().run.run_id, "between-suffixes")
        .await
        .unwrap();
    assert!(f
        .handle
        .with_offline_python_result_fence(&f.token, &mut d, 3, 3, || {
            bytes.extend_from_slice(b"def");
            Ok::<_, ()>(3)
        })
        .is_err());
    assert_eq!(bytes, b"abc");
    assert_eq!(state(&f, id).await, ("delivery_unknown".into(), 3));
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_parent_terminal_and_revocation_deny_actual_bytes() {
    for transition in 0..4 {
        let f = setup().await;
        let (deep, parent) = worker(&f).await;
        let mut d = delivery(&f, &parent, 1).await;
        let id = d.delegation_id();
        match transition {
            0 => {
                f.handle
                    .request_cancel(&f.owner, &d.parent().run.run_id, "worker-stop")
                    .await
                    .unwrap();
            }
            1 => {
                f.handle
                    .request_cancel(&f.owner, &deep.run.run_id, "parent-stop")
                    .await
                    .unwrap();
            }
            2 => {
                f.handle
                    .append_provider_event(&f.owner, &deep, &input(&deep, 2, ProviderEvent::Failed))
                    .await
                    .unwrap();
            }
            _ => {
                f.store.revoke_session(&f.token).await.unwrap();
            }
        }
        let mut bytes = 0;
        assert!(f
            .handle
            .with_offline_python_result_fence(&f.token, &mut d, 0, 1, || {
                bytes += 1;
                Ok::<_, ()>(1)
            })
            .is_err());
        assert_eq!(bytes, 0);
        assert_eq!(state(&f, id).await, ("delivery_unknown".into(), 0));
        cleanup(f).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revocation_precedes_historical_completion_and_reservation_replay() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    let (launch, reservation) = prepared(&f, &parent, 1).await;
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        f.handle
            .prepare_offline_python_result(&f.token, &launch, &output())
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.handle
            .consume_offline_python_result(&f.token, reservation)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(state(&f, launch.id()).await, ("prepared".into(), 0));
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wrong_owner_context_and_tampered_call_cannot_consume_or_write() {
    let f = setup().await;
    let other = setup().await;
    let (_, parent) = worker(&f).await;
    let (_, reservation) = prepared(&f, &parent, 1).await;
    let mut changed = duplicate(&reservation);
    changed.call.turn_id = "other-turn".into();
    assert!(matches!(
        f.handle
            .consume_offline_python_result(&f.token, changed)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert!(other
        .handle
        .consume_offline_python_result(&other.token, duplicate(&reservation))
        .await
        .is_err());
    let OfflinePythonResultConsumption::Deliver(mut d) = f
        .handle
        .consume_offline_python_result(&f.token, reservation)
        .await
        .unwrap()
    else {
        panic!()
    };
    let mut bytes = 0;
    assert!(other
        .handle
        .with_offline_python_result_fence(&other.token, &mut d, 0, 1, || {
            bytes += 1;
            Ok::<_, ()>(1)
        })
        .is_err());
    assert_eq!(bytes, 0);
    cleanup(other).await;
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_authority_refuses_output_preparation_and_has_no_result_grant() {
    let f = setup().await;
    let (_, parent) = worker(&f).await;
    let OfflinePythonAdmission::Fresh(g) = f
        .handle
        .delegate_native_offline_python(&f.token, &parent, &call(1), "print(1)", 100)
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
    tokio::time::sleep(std::time::Duration::from_millis(110)).await;
    assert!(matches!(
        f.handle
            .prepare_offline_python_result(&f.token, &launch, &output())
            .await,
        Err(RuntimeStoreError::Expired)
    ));
    assert_eq!(state(&f, launch.id()).await, ("bound".into(), 0));
    cleanup(f).await;
}
