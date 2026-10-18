use super::*;
use crate::production_runtime::{
    acceptance_tests::proposal,
    tests::{setup, snapshot},
};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;
use std::time::Duration;
fn evidence(b: &Binding) -> NativeSessionConfirmation {
    NativeSessionConfirmation {
        session_id: b.session_id.clone(),
        expected_generation: b.generation,
        native_session_id: b.native_session_id.clone().unwrap(),
        protocol_version: "claude-resume-v1".into(),
        source_event_key: "resume-confirmed".into(),
    }
}
async fn accepted(f: &crate::production_runtime::tests::Case) -> (RunId, Binding) {
    let (p, request) = proposal(f).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    let b = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    (p.run.run_id, b)
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_resume_setup_preserves_native_binding_and_attaches_only_fresh_cap() {
    let f = setup().await;
    let (prior, b) = accepted(&f).await;
    assert!(matches!(
        f.handle.authorize_session_metadata(&b).await,
        Err(RuntimeStoreError::Fenced)
    ));
    let grant = f
        .handle
        .authorize_accepted_session_metadata(&f.token, &prior, &b)
        .await
        .unwrap();
    assert_eq!(grant.binding(), &b);
    assert_eq!(
        f.handle
            .with_metadata_fence(&grant, || Ok::<_, ()>(1))
            .unwrap(),
        Ok(1)
    );
    let original = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let link = f
        .handle
        .confirm_metadata_session(grant, evidence(&b))
        .await
        .unwrap();
    assert_eq!(link.binding(), &original);
    assert!(matches!(
        f.handle
            .with_metadata_fence(link.metadata(), || Ok::<_, ()>(())),
        Err(RuntimeStoreError::Fenced)
    ));
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "resumed-input".into(),
                text: "next accepted turn".into(),
            },
        )
        .await
        .unwrap();
    let claim = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &b.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let run = f
        .handle
        .admit_run(&claim, &b.session_id, b.generation, "resume-admit")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&run, "resume-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) =
        f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    let cap = link.attach_execution(*cap).unwrap();
    assert_eq!(
        cap.provider().binding.native_session_id,
        b.native_session_id
    );
    assert_eq!(
        f.handle
            .with_execution_fence(cap.provider(), || Ok::<_, ()>(2))
            .unwrap(),
        Ok(2)
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_refuses_unaccepted_forged_reissued_and_revoked_authority() {
    let f = setup().await;
    let (p, request) = proposal(&f).await;
    let awaiting = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .authorize_accepted_session_metadata(&f.token, &p.run.run_id, &awaiting)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    let b = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let mut forged = b.clone();
    forged.native_session_id = Some("wrong-native".into());
    assert!(matches!(
        f.handle
            .authorize_accepted_session_metadata(&f.token, &p.run.run_id, &forged)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    let grant = f
        .handle
        .authorize_accepted_session_metadata(&f.token, &p.run.run_id, &b)
        .await
        .unwrap();
    assert!(matches!(
        f.handle
            .authorize_accepted_session_metadata(&f.token, &p.run.run_id, &b)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&reopened).await.unwrap();
    assert!(matches!(
        attached
            .authorize_accepted_session_metadata(&f.token, &p.run.run_id, &b)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    f.store.revoke_session(&f.token).await.unwrap();
    let mut called = false;
    assert!(matches!(
        f.handle.with_metadata_fence(&grant, || {
            called = true;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(!called);
    assert!(matches!(
        f.handle.confirm_metadata_session(grant, evidence(&b)).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admission_racing_setup_fences_old_ready_grant_without_reset() {
    let f = setup().await;
    let (prior, b) = accepted(&f).await;
    let grant = f
        .handle
        .authorize_accepted_session_metadata(&f.token, &prior, &b)
        .await
        .unwrap();
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "intervening".into(),
                text: "next".into(),
            },
        )
        .await
        .unwrap();
    let claim = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &b.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    f.handle
        .admit_run(&claim, &b.session_id, b.generation, "intervening-admit")
        .await
        .unwrap();
    let mut called = false;
    assert!(matches!(
        f.handle.with_metadata_fence(&grant, || {
            called = true;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Fenced)
    ));
    assert!(!called);
    assert!(matches!(
        f.handle.confirm_metadata_session(grant, evidence(&b)).await,
        Err(RuntimeStoreError::Fenced)
    ));
}

#[tokio::test]
async fn independent_connections_issue_one_resume_reservation_without_replacement() {
    let f = setup().await;
    let (prior, b) = accepted(&f).await;
    let pool = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let other = f.handle.reattach_supervisor(&pool).await.unwrap();
    let (a, z) = tokio::join!(
        f.handle
            .authorize_accepted_session_metadata(&f.token, &prior, &b),
        other.authorize_accepted_session_metadata(&f.token, &prior, &b)
    );
    let results = [a, z];
    assert_eq!(results.iter().filter(|v| v.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|v| matches!(v, Err(RuntimeStoreError::Conflict)))
            .count(),
        1
    );
    let rows: Vec<String> = sqlx::query_scalar("SELECT json_object('id',id,'run',prior_run_id,'acceptance',acceptance_event_id,'context',context_id,'incarnation',incarnation_id,'session',session_id,'generation',binding_generation,'state',state,'digest',confirmation_digest) FROM production_resume_metadata ORDER BY id")
        .fetch_all(&f.store.pool).await.unwrap();
    assert_eq!(rows.len(), 1);
    drop(results); // Simulate loss of the only opaque grant, not a transport ACK.
    assert!(matches!(
        other
            .authorize_accepted_session_metadata(&f.token, &prior, &b)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let after:Vec<String>=sqlx::query_scalar("SELECT json_object('id',id,'run',prior_run_id,'acceptance',acceptance_event_id,'context',context_id,'incarnation',incarnation_id,'session',session_id,'generation',binding_generation,'state',state,'digest',confirmation_digest) FROM production_resume_metadata ORDER BY id")
        .fetch_all(&f.store.pool).await.unwrap();
    assert_eq!(after, rows);
}
