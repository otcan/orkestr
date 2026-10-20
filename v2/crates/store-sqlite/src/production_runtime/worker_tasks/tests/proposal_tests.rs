use super::*;

#[tokio::test]
async fn owner_task_projection_keeps_existing_child_live_but_closes_new_admission() {
    for started in [false, true] {
        let f = fixture().await;
        create(&f).await;
        let candidate = candidate(&f).await;
        let cap = consume(&f, &candidate).await;
        let worker = cap.provider().clone();
        drop(cap);
        if started {
            f.core
                .handle
                .append_provider_event(
                    &f.core.owner,
                    &worker,
                    &observation(&worker, 1, ProviderEvent::Started),
                )
                .await
                .unwrap();
        }
        f.core
            .handle
            .append_provider_event(
                &f.core.owner,
                &f.parent,
                &observation(
                    &f.parent,
                    2,
                    ProviderEvent::CompletedProposal { synthetic: false },
                ),
            )
            .await
            .unwrap();
        let before = audit(&f).await;
        let list = statuses(&f).await;
        assert!(!list.can_create);
        assert_eq!(list.tasks[0].run_id, Some(worker.run.run_id.clone()));
        assert_eq!(
            list.tasks[0].phase,
            if started {
                WorkerTaskPhase::Running
            } else {
                WorkerTaskPhase::Preparing
            }
        );
        assert_eq!(
            audit(&f).await,
            before,
            "projection cannot mutate task authority"
        );
        f.core.store.revoke_session(&f.core.token).await.unwrap();
        // The independent browser credential may read history, but cannot turn
        // revoked machine execution back into a live Worker presentation.
        let list = statuses(&f).await;
        assert!(!list.can_create);
        assert_eq!(list.tasks[0].phase, WorkerTaskPhase::Held);
        cleanup(f).await;
    }
}

#[tokio::test]
async fn existing_child_control_and_terminal_projections_keep_their_exact_phase() {
    let f = fixture().await;
    create(&f).await;
    let candidate = candidate(&f).await;
    let cap = consume(&f, &candidate).await;
    let worker = cap.provider().clone();
    drop(cap);
    f.core
        .handle
        .append_provider_event(
            &f.core.owner,
            &worker,
            &observation(&worker, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    f.core
        .handle
        .append_provider_event(
            &f.core.owner,
            &f.parent,
            &observation(
                &f.parent,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    let stop = f
        .core
        .handle
        .request_cancel(&f.core.owner, &worker.run.run_id, "child-stop")
        .await
        .unwrap();
    let before = audit(&f).await;
    assert_eq!(
        statuses(&f).await.tasks[0].phase,
        WorkerTaskPhase::CancelRequested
    );
    assert_eq!(audit(&f).await, before);
    let mut control = worker;
    control.run = stop.new_fenced_admission;
    f.core
        .handle
        .append_provider_event(
            &f.core.owner,
            &control,
            &observation(&control, 2, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
    let before = audit(&f).await;
    assert_eq!(
        statuses(&f).await.tasks[0].phase,
        WorkerTaskPhase::Cancelled
    );
    assert_eq!(audit(&f).await, before);
    cleanup(f).await;
}
