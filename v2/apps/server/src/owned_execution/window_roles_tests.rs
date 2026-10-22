use super::{join_roles, Companion};
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
