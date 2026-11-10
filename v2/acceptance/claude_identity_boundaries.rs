// Append within the exact Core claude_identity_tests module in an owned export.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_setup_revocation_leaves_no_native_reservation() {
    let f = claude().await;
    let b = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let grant = f.handle.authorize_session_metadata(&b).await.unwrap();
    f.store.revoke_session(&f.token).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .initialize_claude_session(grant, initialization(&Uuid::new_v4().to_string()))
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&f.store).await, before);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_stop_or_revoke_prevents_late_identity_observation() {
    for stop in [false, true] {
        let f = claude().await;
        let cap = consume(&f, initialized(&f).await).await;
        let p = cap.provider();
        let native = p.run.native_session_id.as_deref().unwrap();
        // Include an identical observation retry after revocation, rather than
        // checking only first observation under an invalid credential.
        if !stop {
            f.handle
                .observe_claude_session(p, native, "observed-before-revoke")
                .await
                .unwrap();
        }
        if stop {
            f.handle
                .request_cancel(&f.owner, &p.run.run_id, "stop-before-observe")
                .await
                .unwrap();
        } else {
            f.store.revoke_session(&f.token).await.unwrap();
        }
        let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
        let before = snapshot(&reopened).await;
        let result = f
            .handle
            .observe_claude_session(
                p,
                native,
                if stop {
                    "late-init"
                } else {
                    "observed-before-revoke"
                },
            )
            .await;
        if stop {
            assert!(matches!(result, Err(RuntimeStoreError::Fenced)));
        } else {
            assert!(matches!(result, Err(RuntimeStoreError::Unauthorized)));
        }
        assert_eq!(snapshot(&reopened).await, before);
        if stop {
            let lost = input(p, 1, ProviderEvent::Started);
            assert!(f
                .handle
                .append_provider_event(&f.owner, p, &lost)
                .await
                .is_err());
            assert_eq!(snapshot(&reopened).await, before);
        }
    }
}
