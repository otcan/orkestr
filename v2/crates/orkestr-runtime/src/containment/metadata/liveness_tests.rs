//! Observed loss is scoped cleanup, never a durable terminal or retry grant.
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stale_ready_check_cannot_quarantine_transferred_execution() {
    let mut c = Case::new().await;
    let (ready, cap, _) = c.ready().await;
    // A test-only alias exercises the phase fence; production cannot clone the
    // one-use Ready transition or construct this handle.
    let stale = ReadyMetadataChild {
        child: MetadataChild {
            shared: ready.child.shared.clone(),
            process: ready.child.process.clone(),
            broker_launcher: ready.child.broker_launcher,
        },
        transition: None,
    };
    let (authority, execution) = ready
        .attach_and_enqueue(cap, prepare(c.bound.clone()))
        .unwrap();
    assert_eq!(stale.check_broker_liveness(), Err(Error::Revoked));
    assert_eq!(execution.poll_exit(&authority.shared.scope).unwrap(), None);
    execution.flush_stdin(&authority.shared.scope).unwrap();
    assert_eq!(c.authority.shared.active.load(Ordering::Acquire), 1);
    authority.revoke().unwrap();
    drop(stale);
    drop(execution);
    drop(authority);
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ready_exit_reaps_only_original_child_without_changing_durable_authority() {
    let mut a = Case::new().await;
    let mut b = Case::new().await;
    let (ready_a, cap_a, reservation_a) = a.ready().await;
    let (ready_b, cap_b, _) = b.ready().await;
    let before = a
        .bound
        .execution_status(&a.binding.owner_id, &a.binding.conversation_id)
        .await
        .unwrap();
    ready_a.check_broker_liveness().unwrap();
    ready_b.check_broker_liveness().unwrap();
    assert_eq!(a.authority.shared.active.load(Ordering::Acquire), 1);
    let pid = {
        let mut live = ready_a.child.process.live.lock().unwrap();
        let child = live.child.as_mut().unwrap();
        let pid = child.id();
        child.kill().unwrap(); // Exact unreaped test-owned Child, never a lookup.
        pid
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    while ready_a.check_broker_liveness().is_ok() {
        assert!(
            Instant::now() < deadline,
            "owned exit must become observable"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    while a.authority.shared.active.load(Ordering::Acquire) != 0 {
        assert!(Instant::now() < deadline, "original Child must be waited");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    ready_b.check_broker_liveness().unwrap();
    assert_eq!(b.authority.shared.active.load(Ordering::Acquire), 1);
    let mut after = a
        .bound
        .execution_status(&a.binding.owner_id, &a.binding.conversation_id)
        .await
        .unwrap();
    // Sampling the status advances this clock without a durable transition.
    after.as_mut().unwrap().observed_at_ms = before.as_ref().unwrap().observed_at_ms;
    assert_eq!(
        before, after,
        "local loss cannot manufacture durable evidence"
    );
    assert!(matches!(
        ready_a.attach_and_enqueue(cap_a, prepare(a.bound.clone())),
        Err(TurnFailure {
            cause: Error::Revoked
        })
    ));
    a.no_reissue(&reservation_a).await;
    drop(ready_b);
    drop(cap_b);
    a.cleanup().await;
    b.cleanup().await;
}
