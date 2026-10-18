//! Independent ordinary metadata authority checks; included by production_authority.
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_metadata_transition_and_revocation_never_grant_inference() {
    let c = Case::new().await;
    let h = c
        .store
        .authorize_supervisor(&c.token, config())
        .await
        .unwrap();
    let roles = h
        .ensure_role_bindings(&c.owner, &c.conversation)
        .await
        .unwrap();
    let before = c.rows().await;
    let mut forged = roles.deep.clone();
    forged.generation += 1;
    assert!(matches!(
        h.authorize_session_metadata(&forged).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert!(matches!(
        c.store.authorize_session_metadata(&roles.deep).await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert_eq!(before, c.rows().await);
    let grant = h.authorize_session_metadata(&roles.deep).await.unwrap();
    let mut calls = 0;
    assert_eq!(
        h.with_metadata_fence(&grant, || {
            calls += 1;
            Ok::<_, ()>(3)
        })
        .unwrap(),
        Ok(3)
    );
    assert_eq!(before, c.rows().await);
    let link = h
        .confirm_metadata_session(
            grant,
            NativeSessionConfirmation {
                session_id: roles.deep.session_id,
                expected_generation: roles.deep.generation,
                native_session_id: "synthetic-metadata-native".into(),
                protocol_version: "synthetic-v1".into(),
                source_event_key: "metadata:1".into(),
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        h.with_metadata_fence(link.metadata(), || {
            calls += 1;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Fenced)
    ));
    let binding = link.binding().clone();
    c.store
        .admit(
            &c.owner,
            &c.conversation,
            &MessageInput {
                client_message_id: "metadata-input:1".into(),
                text: "durable metadata handoff input".into(),
            },
        )
        .await
        .unwrap();
    let claim = h
        .claim_next(
            &c.owner,
            &c.conversation,
            &binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let fresh = h
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "metadata-run:1",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = h
        .claim_provider_dispatch(&fresh, "metadata-reserve:1")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = h.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    let before = c.rows().await;
    let cap = link.attach_execution(*cap).unwrap();
    assert_eq!(cap.text(), "durable metadata handoff input");
    assert_eq!(
        h.with_execution_fence(cap.provider(), || {
            calls += 1;
            Ok::<_, ()>(4)
        })
        .unwrap(),
        Ok(4)
    );
    assert_eq!(before, c.rows().await);
    let fast_grant = h.authorize_session_metadata(&roles.fast).await.unwrap();
    c.store.revoke_session(&c.token).await.unwrap();
    assert!(matches!(
        h.with_metadata_fence(&fast_grant, || {
            calls += 1;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(calls, 2);
    assert_eq!(before, c.rows().await);
    c.finish().await;
}
