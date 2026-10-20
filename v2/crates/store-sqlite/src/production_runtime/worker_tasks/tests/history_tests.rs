use super::*;
use orkestr_v2_contracts::ExecutionPhase;

async fn completed_worker(f: &Fixture) -> (WorkerTaskReceipt, RunId) {
    let task = create(f).await;
    let candidate = candidate(f).await;
    let cap = consume(f, &candidate).await;
    let worker = cap.provider().clone();
    drop(cap);
    for (sequence, event) in [
        (1, ProviderEvent::Started),
        (
            2,
            ProviderEvent::Progress("synthetic complete reply".into()),
        ),
    ] {
        f.core
            .handle
            .append_provider_event(
                &f.core.owner,
                &worker,
                &observation(&worker, sequence, event),
            )
            .await
            .unwrap();
    }
    let completion = f
        .core
        .handle
        .append_provider_event(
            &f.core.owner,
            &worker,
            &observation(
                &worker,
                3,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    let revision = f
        .core
        .store
        .execution_status(&f.core.owner, &f.core.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    f.core
        .store
        .accept_execution_authenticated(
            &f.browser,
            &f.core.conversation,
            &ExecutionAcceptanceRequest {
                run_id: worker.run.run_id.clone(),
                completion_event_id: completion.event_id,
                expected_revision: revision,
                request_key: "accept-history-worker".into(),
            },
        )
        .await
        .unwrap();
    (task, worker.run.run_id)
}

#[tokio::test]
async fn durable_worker_and_exact_run_history_survive_cold_open_without_authority() {
    let mut f = fixture().await;
    let (task, run) = completed_worker(&f).await;
    f.request.request_key = "pending-history-task".into();
    let pending = create(&f).await;
    f.core.store.revoke_session(&f.core.token).await.unwrap();
    assert!(f
        .core
        .handle
        .execution_run_status_authenticated(&f.browser, &f.core.conversation, &run)
        .await
        .is_err());
    let before = audit(&f).await;
    f.core.store.close().await;
    let cold = Store::open(&f.core.root.join("core.sqlite3"))
        .await
        .unwrap();
    let status = cold
        .execution_run_history_authenticated(
            &f.browser,
            &f.core.owner,
            &f.core.conversation,
            &run,
            false,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.run_id, Some(run.clone()));
    assert_eq!(status.phase, ExecutionPhase::Completed);
    assert!(status.is_valid() && status.progress.is_some());
    assert!(!status.capabilities.stop && !status.capabilities.steer);
    for selected in [&run, &f.parent.run.run_id] {
        assert!(cold
            .execution_run_history_authenticated(
                &f.browser,
                &f.core.owner,
                &f.core.conversation,
                selected,
                true
            )
            .await
            .unwrap()
            .is_none());
    }
    let list = cold
        .worker_task_history_authenticated(
            &f.browser,
            &f.core.owner,
            &f.core.conversation,
            &f.parent.run.run_id,
        )
        .await
        .unwrap();
    assert!(!list.can_create);
    assert_eq!(list.tasks.len(), 2);
    assert_eq!(list.tasks[0].task, task);
    assert_eq!(list.tasks[0].run_id, Some(run));
    assert_eq!(list.tasks[0].phase, WorkerTaskPhase::Completed);
    assert_eq!(list.tasks[1].task, pending);
    assert_eq!(list.tasks[1].phase, WorkerTaskPhase::Held);
    assert!(cold
        .worker_tasks_authenticated(&f.browser, &f.core.conversation, &f.parent.run.run_id)
        .await
        .is_err());
    assert!(cold
        .create_worker_task_authenticated(&f.browser, &f.core.conversation, &f.request)
        .await
        .is_err());
    assert!(cold
        .claim_worker_task(&f.core.token, &f.parent.run.run_id)
        .await
        .is_err());
    f.core.store = cold;
    assert_eq!(
        audit(&f).await,
        before,
        "reads cannot change events, runs, contexts, grants or reservations"
    );
    cleanup(f).await;
}

#[tokio::test]
async fn another_live_context_cannot_hide_old_exact_run_or_worker_history() {
    let f = fixture().await;
    let (task, run) = completed_worker(&f).await;
    let mut configuration = crate::production_runtime::tests::config(ProductionTakeover::First);
    configuration.supervisor_key = "different-live-supervisor".into();
    let newer = f
        .core
        .store
        .authorize_supervisor(&f.core.token, configuration)
        .await
        .unwrap();
    let before = audit(&f).await;
    assert!(newer
        .execution_run_status_authenticated(&f.browser, &f.core.conversation, &run)
        .await
        .unwrap()
        .is_none());
    let status = f
        .core
        .store
        .execution_run_history_authenticated(
            &f.browser,
            &f.core.owner,
            &f.core.conversation,
            &run,
            false,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.phase, ExecutionPhase::Completed);
    assert!(!status.capabilities.stop && !status.capabilities.steer);
    let list = newer
        .worker_tasks_authenticated(&f.browser, &f.core.conversation, &f.parent.run.run_id)
        .await
        .unwrap();
    assert_eq!(list.tasks[0].task, task);
    assert_eq!(list.tasks[0].phase, WorkerTaskPhase::Completed);
    assert!(!list.can_create);
    assert!(matches!(
        newer
            .execution_run_history_authenticated(
                &f.browser,
                &f.core.owner,
                &f.core.conversation,
                &run,
                false
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        newer
            .worker_task_history_authenticated(
                &f.browser,
                &f.core.owner,
                &f.core.conversation,
                &f.parent.run.run_id
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(audit(&f).await, before);
    cleanup(f).await;
}

#[tokio::test]
async fn history_current_session_owner_conversation_and_run_checks_do_not_mutate() {
    let f = fixture().await;
    create(&f).await;
    let foreign = fixture().await;
    let foreign_credential = "browser:foreign-history-session";
    foreign
        .core
        .store
        .save_session(foreign_credential, &foreign.core.owner)
        .await
        .unwrap();
    let before = audit(&f).await;
    for (credential, owner, conversation, expected) in [
        (
            foreign_credential,
            &f.core.owner,
            &f.core.conversation,
            RuntimeStoreError::Unauthorized,
        ),
        (
            &f.browser,
            &foreign.core.owner,
            &f.core.conversation,
            RuntimeStoreError::Unauthorized,
        ),
        (
            &f.browser,
            &f.core.owner,
            &foreign.core.conversation,
            RuntimeStoreError::NotFound,
        ),
    ] {
        assert_eq!(
            f.core
                .store
                .execution_run_history_authenticated(
                    credential,
                    owner,
                    conversation,
                    &f.parent.run.run_id,
                    false
                )
                .await
                .unwrap_err(),
            expected
        );
        assert_eq!(
            f.core
                .store
                .worker_task_history_authenticated(
                    credential,
                    owner,
                    conversation,
                    &f.parent.run.run_id
                )
                .await
                .unwrap_err(),
            expected
        );
    }
    assert!(f
        .core
        .store
        .execution_run_history_authenticated(
            &f.browser,
            &f.core.owner,
            &f.core.conversation,
            &foreign.parent.run.run_id,
            false
        )
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        f.core
            .store
            .worker_task_history_authenticated(
                &f.browser,
                &f.core.owner,
                &f.core.conversation,
                &foreign.parent.run.run_id
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::NotFound
    );
    for expire in [false, true] {
        let credential = format!("browser:{}", if expire { "ce" } else { "cd" }.repeat(32));
        f.core
            .store
            .save_session(&credential, &f.core.owner)
            .await
            .unwrap();
        assert_eq!(
            f.core.store.authenticate(&credential).await.unwrap(),
            Some(f.core.owner.clone())
        );
        if expire {
            sqlx::query("UPDATE auth_sessions SET expires_at=0 WHERE token_hash=?")
                .bind(crate::digest(&credential))
                .execute(&f.core.store.pool)
                .await
                .unwrap();
        } else {
            f.core.store.revoke_session(&credential).await.unwrap();
        }
        assert_eq!(
            f.core
                .store
                .execution_run_history_authenticated(
                    &credential,
                    &f.core.owner,
                    &f.core.conversation,
                    &f.parent.run.run_id,
                    false
                )
                .await
                .unwrap_err(),
            RuntimeStoreError::Unauthorized
        );
        assert_eq!(
            f.core
                .store
                .worker_task_history_authenticated(
                    &credential,
                    &f.core.owner,
                    &f.core.conversation,
                    &f.parent.run.run_id
                )
                .await
                .unwrap_err(),
            RuntimeStoreError::Unauthorized
        );
    }
    assert_eq!(audit(&f).await, before);
    cleanup(foreign).await;
    cleanup(f).await;
}
