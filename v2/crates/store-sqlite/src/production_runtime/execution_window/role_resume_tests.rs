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
    resume_case(false, false).await;
}
#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_companion_resume_rebinds_only_exact_closed_predecessor_atomically() {
    resume_case(true, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bounded_fast_successor_is_fresh_only_after_exact_closed_retirement() {
    resume_case(false, true).await;
}
#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bounded_fast_successor_preserves_workspace_without_resuming_native_history() {
    resume_case(true, true).await;
}
async fn resume_case(with_workspace: bool, bounded: bool) {
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    let (w, project) = if with_workspace {
        let (window, project) = open_project_window().await;
        (window, Some(project))
    } else {
        (Window::open().await, None)
    };
    #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
    let w = {
        assert!(!with_workspace);
        Window::open().await
    };
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
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    let (current, deep_metadata, current_project) = if let Some((allow, path, id)) = &project {
        let (store, metadata, grant) =
            w.f.store
                .reattach_terminal_supervisor_with_workspace(
                    credential.credential(),
                    config,
                    &deep_dispatch.provider().run.run_id,
                    *id,
                    allow.installation(path).unwrap(),
                )
                .await
                .unwrap();
        (store, metadata, Some(grant))
    } else {
        let (store, metadata) =
            w.f.store
                .reattach_terminal_supervisor(
                    credential.credential(),
                    config,
                    &deep_dispatch.provider().run.run_id,
                )
                .await
                .unwrap();
        (store, metadata, None)
    };
    #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
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
        assert!(metadata(
            &current,
            credential.credential(),
            &lost,
            bounded,
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            current_project.as_ref(),
        )
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
    let grant = metadata(
        &current,
        credential.credential(),
        &lost,
        bounded,
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        current_project.as_ref(),
    )
    .await
    .unwrap();
    assert_eq!(grant.binding().role, Role::Fast);
    if bounded {
        assert_ne!(grant.binding().session_id, lost.session_id);
        assert_eq!(grant.binding().native_session_id, None);
    } else {
        assert_eq!(grant.binding().native_session_id, lost.native_session_id);
    }
    assert!(metadata(
        &current,
        credential.credential(),
        &lost,
        bounded,
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        current_project.as_ref(),
    )
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
                native_session_id: ready
                    .native_session_id
                    .clone()
                    .unwrap_or_else(|| "synthetic-bounded-successor".into()),
                protocol_version: "codex-resume-1".into(),
                source_event_key: "fast-exact-resumed".into(),
            },
        )
        .await
        .unwrap();
    if bounded {
        assert_eq!(confirmed.binding().session_id, ready.session_id);
        assert_eq!(confirmed.binding().generation, ready.generation + 1);
        assert_ne!(
            confirmed.binding().native_session_id,
            fast.native_session_id
        );
    } else {
        assert_eq!(confirmed.binding(), &ready);
        assert_eq!(
            confirmed.binding().native_session_id,
            fast.native_session_id
        );
    }
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    if let Some((_, path, _)) = project {
        std::fs::remove_dir_all(path).unwrap();
    }
}

async fn metadata(
    store: &Store,
    credential: &str,
    binding: &Binding,
    bounded: bool,
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))] workspace: Option<
        &WorkspaceGrant,
    >,
) -> Result<BoundSessionMetadata> {
    if bounded {
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        if let Some(workspace) = workspace {
            return store
                .authorize_bounded_fast_metadata_with_workspace(credential, binding, workspace)
                .await;
        }
        return store
            .authorize_bounded_fast_metadata(credential, binding)
            .await;
    }
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    if let Some(workspace) = workspace {
        return store
            .authorize_window_fast_metadata_with_workspace(credential, binding, workspace)
            .await;
    }
    store
        .authorize_window_fast_metadata(credential, binding)
        .await
}

#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
async fn open_project_window() -> (
    Window,
    (WorkspaceOperatorAllowlist, std::path::PathBuf, Uuid),
) {
    use std::os::unix::fs::MetadataExt;
    let f = fixtures::setup().await;
    let browser = browser(&f).await;
    let mut roles = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap();
    let path = f.root.with_extension("workspace");
    std::fs::create_dir_all(path.join(".git")).unwrap();
    let allow = WorkspaceOperatorAllowlist::new(
        vec![path.clone()],
        vec![f.root.clone()],
        std::fs::metadata(&path).unwrap().uid(),
    )
    .unwrap();
    let id = Uuid::new_v4();
    let grant = f
        .handle
        .register_workspace(
            &f.token,
            &f.conversation,
            id,
            allow.installation(&path).unwrap(),
        )
        .await
        .unwrap();
    for binding in [&roles.deep, &roles.fast] {
        f.handle
            .bind_workspace_session(&f.token, &grant, binding)
            .await
            .unwrap();
    }
    roles.deep = fixtures::ready(&f).await;
    let old = input(&f, "old-project-input").await;
    let source = input(&f, "project-window-input").await;
    let status = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &source)
        .await
        .unwrap()
        .status;
    let credential = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            status.window_id,
            1,
            "role-test-boot",
            status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    let bound = f
        .handle
        .bind_execution_window(&f.token, &credential)
        .await
        .unwrap();
    bound
        .register_workspace(
            credential.credential(),
            &f.conversation,
            id,
            allow.installation(&path).unwrap(),
        )
        .await
        .unwrap();
    (
        Window {
            f,
            browser_credential: browser,
            bound,
            credential,
            status,
            roles,
            old,
            source,
        },
        (allow, path, id),
    )
}
