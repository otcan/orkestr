use super::join_roles;
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
