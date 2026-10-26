//! Fast acceptance releases its exact binding, never Deep or the live window.
//! This is a ledger/fence fixture; it makes no native child-reap claim.
use super::*;
use orkestr_v2_contracts::ExecutionAcceptanceRequest;

async fn deep_authority(store: &Store) -> (Vec<String>, Vec<String>, Vec<String>) {
    let runs = sqlx::query_scalar("SELECT json_array(id,session_id,native_session_id,binding_generation,lease_generation,dispatch_fence,state,dispatch_state,context_id,incarnation_id) FROM production_runs WHERE role='deep' ORDER BY id")
        .fetch_all(&store.pool).await.unwrap();
    let leases = sqlx::query_scalar("SELECT json_array(l.run_id,l.generation,l.lease_deadline_ms,l.dispatch_fence,l.purpose) FROM production_run_leases l JOIN production_runs r ON r.id=l.run_id WHERE r.role='deep' ORDER BY l.run_id")
        .fetch_all(&store.pool).await.unwrap();
    let inbox = sqlx::query_scalar("SELECT json_array(conversation_id,sequence,event_id,message_id,state,claim_generation,claimant_session_id,claim_deadline_ms,admitted_run_id) FROM reasoning_inbox ORDER BY conversation_id,sequence")
        .fetch_all(&store.pool).await.unwrap();
    (runs, leases, inbox)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepting_fast_while_deep_runs_preserves_window_inbox_and_deep_fence() {
    let w = Window::open().await;
    let fast = w.ready_fast().await;
    w.activate().await;
    let fast_admission = w
        .bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: w.source.input_message_id.clone(),
                source_event_id: w.source.input_event_id.clone(),
                fast_binding_id: fast.session_id.clone(),
                expected_binding_generation: fast.generation,
                request_key: "independent-fast".into(),
            },
        )
        .await
        .unwrap();
    let fast_dispatch = w.consume(&fast_admission).await;
    let claim = w
        .bound
        .claim_next(
            &w.f.owner,
            &w.f.conversation,
            &w.roles.deep.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let deep_admission = w
        .bound
        .admit_run(
            &claim,
            &w.roles.deep.session_id,
            w.roles.deep.generation,
            "independent-deep",
        )
        .await
        .unwrap();
    let deep_dispatch = w.consume(&deep_admission).await;
    for provider in [deep_dispatch.provider(), fast_dispatch.provider()] {
        w.bound
            .append_provider_event(
                &w.f.owner,
                provider,
                &observation(provider, 1, ProviderEvent::Started),
            )
            .await
            .unwrap();
    }
    let fast_provider = fast_dispatch.provider();
    let done = w
        .bound
        .append_provider_event(
            &w.f.owner,
            fast_provider,
            &observation(
                fast_provider,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    let window_before =
        w.f.store
            .execution_window_status_authenticated(&w.browser_credential, &w.f.conversation)
            .await
            .unwrap();
    let roles_before = w
        .bound
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap();
    let deep_before = deep_authority(&w.f.store).await;
    let revision =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(w.f.conversation.to_string())
            .fetch_one(&w.f.store.pool)
            .await
            .unwrap();
    let request = ExecutionAcceptanceRequest {
        run_id: fast_provider.run.run_id.clone(),
        completion_event_id: done.event_id,
        expected_revision: revision,
        request_key: "independent-owner-fast-accept".into(),
    };
    let receipt =
        w.f.store
            .accept_execution_authenticated(&w.browser_credential, &w.f.conversation, &request)
            .await
            .unwrap();
    assert_eq!(receipt.run_id, fast_provider.run.run_id);
    assert_eq!(deep_authority(&w.f.store).await, deep_before);
    assert_eq!(
        w.f.store
            .execution_window_status_authenticated(&w.browser_credential, &w.f.conversation)
            .await
            .unwrap(),
        window_before,
        "identity, generation, state, work deadline and cleanup deadline stay unchanged"
    );
    let roles_after = w
        .bound
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap();
    assert_eq!(roles_after.deep, roles_before.deep);
    assert_eq!(roles_after.fast.session_id, roles_before.fast.session_id);
    assert_eq!(
        roles_after.fast.native_session_id,
        roles_before.fast.native_session_id
    );
    assert_eq!(roles_after.fast.role, Role::Fast);
    assert_eq!(roles_after.fast.state, SessionState::Ready);
    assert_eq!(
        roles_after.fast.generation,
        roles_before.fast.generation + 1
    );
    assert!(w
        .bound
        .with_execution_fence(fast_provider, || Ok::<_, ()>(()))
        .is_err());
    assert_eq!(
        w.bound
            .with_execution_fence(deep_dispatch.provider(), || Ok::<_, ()>(7))
            .unwrap(),
        Ok(7)
    );
    assert!(!w
        .f
        .store
        .execution_window_switch_ready_authenticated(&w.browser_credential, &w.f.conversation)
        .await
        .unwrap());
    assert_eq!(
        w.f.store
            .accept_execution_authenticated(&w.browser_credential, &w.f.conversation, &request)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(deep_authority(&w.f.store).await, deep_before);
}
