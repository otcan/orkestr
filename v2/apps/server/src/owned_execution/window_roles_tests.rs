use super::{fast_beside_pool, join_roles, Companion};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::{oneshot, Mutex};

struct Retained(Arc<AtomicBool>);
impl Drop for Retained {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn synchronous_fence_can_wait_for_another_roles_async_transaction() {
    let transaction = Arc::new(Mutex::new(()));
    let deep_transaction = transaction.clone();
    let (locked, holding) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let deep = async move {
        let guard = deep_transaction.lock().await;
        locked.send(()).unwrap();
        released.await.unwrap();
        drop(guard);
        Ok(())
    };
    let fast = async move {
        holding.await.unwrap();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                release.send(()).unwrap();
                let guard = tokio::time::timeout(Duration::from_secs(1), transaction.lock())
                    .await
                    .map_err(|_| "other role transaction was suspended")?;
                drop(guard);
                Ok(())
            })
        })
    };
    assert_eq!(join_roles(deep, fast, |_| {}).await, Ok(()));
}

#[tokio::test]
async fn role_failure_joins_the_aborted_sibling_before_returning() {
    let dropped = Arc::new(AtomicBool::new(false));
    let retained = Retained(dropped.clone());
    let (started, ready) = oneshot::channel();
    let sibling = async move {
        let _retained = retained;
        started.send(()).unwrap();
        std::future::pending::<Result<(), &'static str>>().await
    };
    let failing = async move {
        ready.await.unwrap();
        Err("synthetic role refusal")
    };
    assert_eq!(
        join_roles(failing, sibling, |_| panic!(
            "Deep failure is not a Fast failure"
        ))
        .await,
        Err("synthetic role refusal")
    );
    assert!(dropped.load(Ordering::Acquire));
}

#[tokio::test]
async fn cancelling_the_owner_does_not_detach_its_role_tasks() {
    let dropped = Arc::new(AtomicBool::new(false));
    let retained = Retained(dropped.clone());
    let (started, ready) = oneshot::channel();
    let sibling = async move {
        let _retained = retained;
        started.send(()).unwrap();
        std::future::pending::<Result<(), &'static str>>().await
    };
    let owner = tokio::spawn(join_roles(std::future::pending(), sibling, |_| {}));
    ready.await.unwrap();
    owner.abort();
    assert!(owner.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(1), async {
        while !dropped.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("role task retained after owner cancellation");
}

#[tokio::test]
async fn a_failed_fast_companion_never_aborts_its_deep_owner() {
    let (finish, finished) = oneshot::channel::<()>();
    let reported = Arc::new(std::sync::Mutex::new(None));
    let seen = reported.clone();
    let deep = async move {
        finished.await.unwrap();
        Ok(())
    };
    let fast = async move { Err("synthetic Fast lost") };
    let joined = tokio::spawn(join_roles(deep, fast, move |reason| {
        *seen.lock().unwrap() = Some(reason);
        finish.send(()).unwrap();
    }));
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), joined)
            .await
            .unwrap()
            .unwrap(),
        Ok(())
    );
    assert_eq!(*reported.lock().unwrap(), Some("synthetic Fast lost"));
}

async fn companion() -> (Arc<Companion>, std::path::PathBuf) {
    use orkestr_v2_contracts::{ConversationId, OwnerId};
    let directory = std::env::temp_dir().join(format!("window-companion-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let store = orkestr_v2_store_sqlite::Store::open(&directory.join("core.sqlite3"))
        .await
        .unwrap();
    let companion = Companion::new(crate::execution_registry::ExecutionScope {
        store,
        control: Some(crate::control_registry::ControlRegistry::new(
            OwnerId(uuid::Uuid::new_v4()),
            ConversationId(uuid::Uuid::new_v4()),
        )),
        tasks: None,
    });
    (companion, directory)
}

/// Production 04:43Z/05:43Z: a Fast companion that never got its timer
/// presentation neither started nor failed, and Deep aborted the whole window
/// ("Fast companion setup incomplete"). Now Deep fails Fast and goes on alone.
#[tokio::test]
async fn deep_fails_a_silent_fast_companion_and_continues_alone() {
    for ready in [true, false] {
        let (companion, directory) = companion().await;
        if !ready {
            // Fast became ready but never presented anything.
            assert!(companion.claim_ready());
        }
        assert_eq!(companion.setup_progress(ready, false, false), None);
        assert_eq!(companion.setup_progress(ready, false, true), Some(Ok(())));
        assert!(companion.has_failed());
        // The abandoned companion never becomes ready or presents later.
        assert!(!companion.claim_ready());
        assert!(!companion.claim_start());
        // Retirement no longer waits for its proof or start.
        assert!(!companion.ready_to_close());
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[tokio::test]
async fn shutdown_or_work_deadline_still_ends_companion_setup() {
    let (companion, directory) = companion().await;
    assert_eq!(
        companion.setup_progress(true, true, true),
        Some(Err("Fast companion setup incomplete"))
    );
    assert!(!companion.has_failed());
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn a_claimed_fast_stage_is_never_abandoned() {
    let (companion, directory) = companion().await;
    assert!(companion.claim_ready());
    assert_eq!(companion.setup_progress(true, false, true), Some(Ok(())));
    // A dispatch in flight keeps Deep waiting for its start, not failing it.
    assert!(companion.claim_start());
    assert_eq!(companion.setup_progress(false, false, true), None);
    assert!(!companion.has_failed());
    companion.started();
    assert_eq!(companion.setup_progress(false, false, true), Some(Ok(())));
    assert!(companion.ready_to_close());
    std::fs::remove_dir_all(directory).unwrap();
}

/// Fast's claim and Deep's timeout race: exactly one of them wins, so a Fast
/// never dispatches after Deep went on without it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fast_claim_and_deep_abandonment_are_exclusive() {
    let (first, directory) = companion().await;
    for _ in 0..200 {
        let companion = Companion::new(first.scope());
        assert!(companion.claim_ready());
        let fast = companion.clone();
        let claim = tokio::task::spawn_blocking(move || fast.claim_start());
        let deep = companion.clone();
        let abandon = tokio::task::spawn_blocking(move || deep.setup_progress(false, false, true));
        let (claimed, decided) = (claim.await.unwrap(), abandon.await.unwrap());
        assert_ne!(claimed, companion.has_failed());
        assert_eq!(decided.is_some(), companion.has_failed());
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_fast_is_reported_while_the_parallel_pool_still_runs() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let reported = std::sync::Arc::new(AtomicBool::new(false));
    let (release, released) = tokio::sync::oneshot::channel::<()>();
    let pool_done = std::sync::Arc::new(AtomicBool::new(false));
    let pool = {
        let pool_done = pool_done.clone();
        async move {
            let _ = released.await;
            pool_done.store(true, Ordering::Release);
        }
    };
    let side = tokio::spawn(fast_beside_pool(
        async { Err::<(), _>("synthetic Fast failure") },
        Some(pool),
        {
            let reported = reported.clone();
            move || reported.store(true, Ordering::Release)
        },
    ));
    // Reported promptly, while the pool (live slots) is still running.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !reported.load(Ordering::Acquire) {
        assert!(
            std::time::Instant::now() < deadline,
            "Fast failure reported late"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(!pool_done.load(Ordering::Acquire));
    assert!(!side.is_finished(), "the side role waits for its pool");
    release.send(()).unwrap();
    assert_eq!(side.await.unwrap(), Err("synthetic Fast failure"));
    assert!(pool_done.load(Ordering::Acquire));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_healthy_fast_reports_nothing_and_no_pool_is_fine() {
    let pool: Option<std::future::Ready<()>> = None;
    assert_eq!(
        fast_beside_pool(async { Ok(()) }, pool, || panic!("not failed")).await,
        Ok(())
    );
}

/// `service_parallel_deep_http` flake ("Fast observation refused by
/// Provider(Protocol)", about 1 in 5 runs): the owner stopped the writer while
/// a held Fast turn was running. Fast's step saw the companion not retiring,
/// then Deep's close moved Core's window to `retiring` before that step's
/// fenced stdin flush, whose execution fence then refused it (the window
/// must be `active`), and the window needed reconciliation. Now retirement
/// waits for such a step, and every later step sees `retiring` (the
/// ordinary Stop path).
#[tokio::test]
async fn window_retirement_waits_for_a_running_fast_step() {
    let (companion, directory) = companion().await;
    // Core's window state as the Fast execution fence reads it.
    let active = Arc::new(AtomicBool::new(true));
    let step = companion.step().await;
    assert!(!companion.retiring(), "this step goes on running");
    let close = tokio::spawn({
        let companion = companion.clone();
        let active = active.clone();
        async move {
            companion.retire_quiesced().await;
            // `begin_execution_window_retirement`: active -> retiring.
            active.store(false, Ordering::Release);
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(companion.retiring(), "retirement already requested");
    assert!(
        !close.is_finished(),
        "Core retirement must wait for the step"
    );
    // The step's fenced write (stdin flush) still sees an active window.
    assert!(active.load(Ordering::Acquire));
    drop(step);
    tokio::time::timeout(Duration::from_secs(5), close)
        .await
        .expect("retirement proceeds once the step ended")
        .unwrap();
    assert!(!active.load(Ordering::Acquire));
    // Every later step sees the retirement before any fenced write.
    let later = companion.step().await;
    assert!(companion.retiring());
    drop(later);
    // Without a running step, retirement never waits.
    let (idle, idle_directory) = self::companion().await;
    tokio::time::timeout(Duration::from_secs(5), idle.retire_quiesced())
        .await
        .expect("no step holds an idle companion's retirement");
    let _ = std::fs::remove_dir_all(directory);
    let _ = std::fs::remove_dir_all(idle_directory);
}
