//! Closed-window companion reattachment, using only canonical terminal records.
use super::*;
use orkestr_v2_contracts::ExecutionAcceptanceRequest;

async fn accept(w: &Window, provider: &ProviderAdmission, key: &str) {
    w.bound
        .append_provider_event(
            &w.f.owner,
            provider,
            &observation(provider, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let done = w
        .bound
        .append_provider_event(
            &w.f.owner,
            provider,
            &observation(
                provider,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(w.f.conversation.to_string())
            .fetch_one(&w.f.store.pool)
            .await
            .unwrap();
    w.f.store
        .accept_execution_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: provider.run.run_id.clone(),
                completion_event_id: done.event_id,
                expected_revision: revision,
                request_key: key.into(),
            },
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn companion_resume_requires_exact_closed_predecessor_and_is_single_use() {
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
                request_key: "resume-fast-first".into(),
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
            "resume-deep-first",
        )
        .await
        .unwrap();
    let deep_dispatch = w.consume(&deep_admission).await;
    accept(&w, fast_dispatch.provider(), "accept-fast-first").await;
    accept(&w, deep_dispatch.provider(), "accept-deep-first").await;
    w.bound
        .begin_execution_window_retirement(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot",
        )
        .await
        .unwrap();
    w.bound
        .retire_terminal_supervisor(
            w.credential.credential(),
            &deep_dispatch.provider().run.run_id,
        )
        .await
        .unwrap();
    let (retired, handoff) = w
        .bound
        .retire_execution_window(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot",
            &deep_dispatch.provider().run.run_id,
        )
        .await
        .unwrap();
    let mut request = input(&w.f, "resume-second-window").await;
    request.expected_generation = 1;
    request.predecessor_window_id = Some(w.status.window_id);
    let next = w
        .f
        .store
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &request)
        .await
        .unwrap();
    let credential = retired
        .issue_execution_window_credential(
            handoff.credential(),
            next.status.window_id,
            2,
            "role-test-boot",
            next.status.expires_at_ms,
            &"b".repeat(64),
        )
        .await
        .unwrap();
    let config = fixtures::config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: retired.supervisor_incarnation().unwrap().into(),
    });
    let (current, deep_metadata) =
        w.f.store
            .reattach_terminal_supervisor(
                credential.credential(),
                config,
                &deep_dispatch.provider().run.run_id,
            )
            .await
            .unwrap();
    let lost = current
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap()
        .fast;
    assert_eq!(lost.state, SessionState::Lost);
    assert_eq!(
        lost.native_session_id,
        fast_dispatch.provider().binding.native_session_id
    );
    assert!(current
        .authorize_window_fast_metadata(credential.credential(), deep_metadata.binding())
        .await
        .is_err());
    for (target, column, changed) in [
        (
            next.status.window_id,
            "state",
            "reconciliation_required".to_string(),
        ),
        (
            w.status.window_id,
            "terminal_run_id",
            fast_dispatch.provider().run.run_id.to_string(),
        ),
    ] {
        let original: String = sqlx::query_scalar(&format!(
            "SELECT {column} FROM execution_windows WHERE id=?"
        ))
        .bind(target.to_string())
        .fetch_one(&w.f.store.pool)
        .await
        .unwrap();
        sqlx::query(&format!(
            "UPDATE execution_windows SET {column}=? WHERE id=?"
        ))
        .bind(changed)
        .bind(target.to_string())
        .execute(&w.f.store.pool)
        .await
        .unwrap();
        let before = fixtures::snapshot(&w.f.store).await;
        assert!(current
            .authorize_window_fast_metadata(credential.credential(), &lost)
            .await
            .is_err());
        assert_eq!(before, fixtures::snapshot(&w.f.store).await);
        sqlx::query(&format!(
            "UPDATE execution_windows SET {column}=? WHERE id=?"
        ))
        .bind(original)
        .bind(target.to_string())
        .execute(&w.f.store.pool)
        .await
        .unwrap();
    }
    let grant = current
        .authorize_window_fast_metadata(credential.credential(), &lost)
        .await
        .unwrap();
    assert_eq!(grant.binding().role, Role::Fast);
    assert_eq!(grant.binding().native_session_id, lost.native_session_id);
    assert!(current
        .authorize_window_fast_metadata(credential.credential(), &lost)
        .await
        .is_err());
    assert_eq!(
        current
            .with_metadata_fence(&grant, || Ok::<_, ()>(1))
            .unwrap(),
        Ok(1)
    );
    let ready = grant.binding().clone();
    let confirmed = current
        .confirm_metadata_session(
            grant,
            NativeSessionConfirmation {
                session_id: ready.session_id.clone(),
                expected_generation: ready.generation,
                native_session_id: ready.native_session_id.clone().unwrap(),
                protocol_version: "codex-resume-1".into(),
                source_event_key: "fast-exact-resumed".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(confirmed.binding(), &ready);
    assert_eq!(
        confirmed.binding().native_session_id,
        fast.native_session_id
    );
}
