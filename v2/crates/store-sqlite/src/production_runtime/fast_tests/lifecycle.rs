use super::*;
use crate::production_runtime::observation_tests::input as event;
use orkestr_v2_contracts::ExecutionAcceptanceRequest;

async fn accepted_fast(f: &Case) -> (ProviderAdmission, Binding) {
    let i = input(f).await;
    let a = f.handle.admit_fast(&f.token, &i).await.unwrap();
    let DispatchClaimResult::Reserved(r) = f
        .handle
        .claim_provider_dispatch(&a, "fast-life")
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(matches!(
        f.handle.consume_execution(&r).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    let p = a.provider;
    f.handle
        .append_provider_event(&f.owner, &p, &event(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let done = f
        .handle
        .append_provider_event(
            &f.owner,
            &p,
            &event(&p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    let before = harness::snapshot(&f.store).await;
    let busy = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .fast;
    assert!(f
        .handle
        .authorize_accepted_session_metadata(&f.token, &p.run.run_id, &busy)
        .await
        .is_err());
    assert_eq!(before, harness::snapshot(&f.store).await);
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(f.conversation.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    let request = ExecutionAcceptanceRequest {
        run_id: p.run.run_id.clone(),
        completion_event_id: done.event_id,
        expected_revision: revision,
        request_key: "fast-owner-decision".into(),
    };
    let receipt = f
        .store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    assert_eq!(
        receipt,
        f.store
            .accept_execution_authenticated(&f.token, &f.conversation, &request)
            .await
            .unwrap()
    );
    let b = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .fast;
    (p, b)
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_cursor_is_readonly_skips_scheduled_and_refuses_revocation() {
    let f = harness::setup().await;
    let i = input(&f).await;
    let before = harness::snapshot(&f.store).await;
    let source = f
        .handle
        .next_fast_source(&f.token, &f.conversation, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source.event_id, i.source_event_id);
    assert_eq!(source.message_id, i.source_message_id);
    assert_eq!(before, harness::snapshot(&f.store).await);
    assert!(f
        .handle
        .next_fast_source(&f.token, &f.conversation, source.sequence)
        .await
        .unwrap()
        .is_none());
    f.handle.admit_fast(&f.token, &i).await.unwrap();
    assert!(f
        .handle
        .next_fast_source(&f.token, &f.conversation, 0)
        .await
        .unwrap()
        .is_none());
    let before = inbox(&f).await;
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(f
        .handle
        .next_fast_source(&f.token, &f.conversation, 0)
        .await
        .is_err());
    assert_eq!(before, inbox(&f).await);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fast_owner_accepted_resume_preserves_role_native_and_single_setup() {
    let f = harness::setup().await;
    let before = inbox(&f).await;
    let (p, b) = accepted_fast(&f).await;
    let grant = f
        .handle
        .authorize_accepted_session_metadata(&f.token, &p.run.run_id, &b)
        .await
        .unwrap();
    assert_eq!(grant.binding().role, Role::Fast);
    assert_eq!(
        grant.binding().native_session_id,
        p.binding.native_session_id
    );
    assert!(f
        .handle
        .authorize_accepted_session_metadata(&f.token, &p.run.run_id, &b)
        .await
        .is_err());
    f.handle
        .with_metadata_fence(&grant, || Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
    let link = f
        .handle
        .confirm_metadata_session(
            grant,
            NativeSessionConfirmation {
                session_id: b.session_id.clone(),
                expected_generation: b.generation,
                native_session_id: b.native_session_id.clone().unwrap(),
                protocol_version: "codex-resume-1".into(),
                source_event_key: "fast-resume".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(link.binding(), &b);
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "fast-next".into(),
                text: "next immutable presentation".into(),
            },
        )
        .await
        .unwrap();
    let source = f
        .handle
        .next_fast_source(&f.token, &f.conversation, 0)
        .await
        .unwrap()
        .unwrap();
    let next = FastAdmissionInput {
        source_message_id: source.message_id,
        source_event_id: source.event_id,
        fast_binding_id: b.session_id.clone(),
        expected_binding_generation: b.generation,
        request_key: "fast-next".into(),
    };
    let a = f.handle.admit_fast(&f.token, &next).await.unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&a, "fast-next-reserve")
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
    assert_eq!(
        link.attach_execution(*cap).unwrap().provider().run.role,
        Role::Fast
    );
    assert!(before.is_empty());
    assert_eq!(inbox(&f).await.len(), 2);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fast_graceful_retirement_discovers_exact_accepted_predecessor() {
    let f = harness::setup().await;
    let (p, _) = accepted_fast(&f).await;
    f.handle
        .retire_terminal_supervisor(&f.token, &p.run.run_id)
        .await
        .unwrap();
    let c = f.handle.context().unwrap();
    let mut config = ProductionSupervisorConfig {
        provider: c.provider,
        namespace: c.namespace.clone(),
        supervisor_key: c.key.clone(),
        takeover: ProductionTakeover::First,
    };
    let (prior, incarnation) = f
        .store
        .terminal_supervisor_candidate(&f.token, &config, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(prior, p.run.run_id);
    config.takeover = ProductionTakeover::ExpiredPredecessor {
        incarnation_id: incarnation,
    };
    let (bound, grant) = f
        .store
        .reattach_terminal_supervisor(&f.token, config, &prior)
        .await
        .unwrap();
    assert_eq!(grant.binding().role, Role::Fast);
    bound
        .with_metadata_fence(&grant, || Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn fast_source_selected_before_stop_is_held_and_fresh_intent_remains_independent() {
    let f = harness::setup().await;
    let deep = crate::production_runtime::observation_tests::consumed(&f).await;
    let i = input(&f).await;
    f.handle.admit_fast(&f.token, &i).await.unwrap();
    let cursor: i64 = sqlx::query_scalar("SELECT sequence FROM events WHERE id=?")
        .bind(i.source_event_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "held-fast".into(),
                text: "held owner input".into(),
            },
        )
        .await
        .unwrap();
    let selected = f
        .handle
        .next_fast_source(&f.token, &f.conversation, cursor)
        .await
        .unwrap()
        .unwrap();
    f.handle
        .request_cancel(&f.owner, &deep.run.run_id, "stop-before-fast-admit")
        .await
        .unwrap();
    assert!(f
        .handle
        .next_fast_source(&f.token, &f.conversation, cursor)
        .await
        .unwrap()
        .is_none());
    let before = harness::snapshot(&f.store).await;
    let mut next = i;
    next.source_message_id = selected.message_id;
    next.source_event_id = selected.event_id;
    next.request_key = "held-next-fast".into();
    assert!(matches!(
        f.handle.admit_fast(&f.token, &next).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(before, harness::snapshot(&f.store).await);
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "fresh-fast".into(),
                text: "fresh post Stop intent".into(),
            },
        )
        .await
        .unwrap();
    assert!(
        f.handle
            .next_fast_source(&f.token, &f.conversation, cursor)
            .await
            .unwrap()
            .unwrap()
            .sequence
            > selected.sequence
    );
}
