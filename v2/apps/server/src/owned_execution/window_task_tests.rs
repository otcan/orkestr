use super::*;

fn task(
    future: impl std::future::Future<Output = Result<(), &'static str>> + Send + 'static,
) -> WindowTask {
    let (shutdown, _receiver) = watch::channel(false);
    WindowTask {
        shutdown,
        task: Some(tokio::spawn(future)),
        children: crate::owned_children::ChildSet::default(),
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
