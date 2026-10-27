use super::*;

fn task(
    future: impl std::future::Future<Output = Result<(), &'static str>> + Send + 'static,
) -> WindowTask {
    let (shutdown, _receiver) = watch::channel(false);
    WindowTask {
        shutdown,
        task: Some(tokio::spawn(future)),
        children: crate::owned_children::ChildSet::default(),
        context: None,
        companion: None,
    }
}

#[tokio::test]
async fn task_error_is_observable_instead_of_becoming_cleanup_success() {
    let mut task = task(async { Err("synthetic execution refused") });
    assert_eq!(
        task.stop_until(tokio::time::Instant::now() + Duration::from_secs(1))
            .await,
        Err("synthetic execution refused")
    );
    assert!(task.poll().await.is_none());
}

#[tokio::test]
async fn an_expired_original_deadline_never_waits_for_a_stalled_task() {
    let mut task = task(std::future::pending());
    assert_eq!(
        task.stop_until(tokio::time::Instant::now()).await,
        Err("window cleanup deadline exceeded; reconciliation required")
    );
    assert!(task.task.is_none());
}

#[tokio::test]
async fn task_return_does_not_substitute_for_outstanding_resource_cleanup() {
    let mut task = task(async { Ok(()) });
    let retained = task.children.retain();
    assert_eq!(
        task.stop_until(tokio::time::Instant::now() + Duration::from_millis(10))
            .await,
        Err("window resources remain; reconciliation required")
    );
    drop(retained);
}

#[tokio::test]
async fn finished_task_is_observable_after_original_cleanup_deadline() {
    let mut finished = task(async { Ok(()) });
    while !finished.task.as_ref().unwrap().is_finished() {
        tokio::task::yield_now().await;
    }
    let expired = tokio::time::Instant::now() - Duration::from_secs(15);
    // This is the old Controller::shutdown path: a completed task is joined,
    // but the expired cleanup barrier still reports an error with no children.
    assert_eq!(
        finished.stop_until(expired).await,
        Err("window resources remain; reconciliation required")
    );
    let mut finished = task(async { Ok(()) });
    while !finished.task.as_ref().unwrap().is_finished() {
        tokio::task::yield_now().await;
    }
    // Refresh consumes the existing outcome without opening a cleanup budget.
    assert_eq!(finished.poll().await, Some(Ok(())));
    assert!(finished.poll().await.is_none());
}

#[tokio::test]
async fn idle_close_waits_for_a_fast_slot_still_in_setup() {
    use orkestr_v2_contracts::{ConversationId, OwnerId};
    let directory =
        std::env::temp_dir().join(format!("window-slot-close-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let store = orkestr_v2_store_sqlite::Store::open(&directory.join("core.sqlite3"))
        .await
        .unwrap();
    let companion = window_roles::Companion::new(crate::execution_registry::ExecutionScope {
        store,
        control: Some(crate::control_registry::ControlRegistry::new(
            OwnerId(uuid::Uuid::new_v4()),
            ConversationId(uuid::Uuid::new_v4()),
        )),
        tasks: None,
    });
    assert!(companion.claim_ready());
    assert!(companion.claim_start());
    companion.started();
    let mut task = task(std::future::pending());
    task.companion = Some(companion.clone());
    assert!(task.roles_ready_to_close());
    assert!(companion.enter_slot());
    assert!(!task.roles_ready_to_close());
    companion.leave_slot(None);
    assert!(task.roles_ready_to_close());
    std::fs::remove_dir_all(directory).unwrap();
}
