//! Real window boundaries for terminal physical preflight.
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_expired_owned_terminal_window_handoff_refreshes_after_rollback() {
    let f = prepared_restart(false, false, false).await;
    let config = fixtures::config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: f.retired.supervisor_incarnation().unwrap().into(),
    });
    let result = f
        .store
        .reattach_terminal_supervisor_with_workspace(
            f.credential.credential(),
            config,
            &f.prior,
            f.project,
            f.installation,
        )
        .await;
    let (next, metadata, grant) = result.expect("one pre-effect physical expiry should refresh");
    assert_ne!(
        next.supervisor_incarnation(),
        f.retired.supervisor_incarnation()
    );
    assert_eq!(
        metadata.binding().session_id,
        f.window.roles.deep.session_id
    );
    assert_eq!(grant.generation(), 1);
    assert_eq!(f.probe.calls.load(Ordering::SeqCst), 2);
    assert!(f.probe.writer_free.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_terminal_handoff_expiry_never_loops_or_persists_takeover() {
    let f = prepared_restart(true, false, false).await;
    let before = fixtures::snapshot(&f.window.f.store).await;
    let config = fixtures::config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: f.retired.supervisor_incarnation().unwrap().into(),
    });
    let result = f
        .store
        .reattach_terminal_supervisor_with_workspace(
            f.credential.credential(),
            config,
            &f.prior,
            f.project,
            f.installation,
        )
        .await;
    assert!(matches!(result, Err(RuntimeStoreError::Fenced)));
    assert_eq!(f.probe.calls.load(Ordering::SeqCst), 2);
    assert!(f.probe.writer_free.load(Ordering::SeqCst));
    assert_eq!(before, fixtures::snapshot(&f.window.f.store).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_root_policy_refusal_after_expiry_never_rebinds() {
    let f = prepared_restart(false, true, false).await;
    let before = fixtures::snapshot(&f.window.f.store).await;
    let config = fixtures::config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: f.retired.supervisor_incarnation().unwrap().into(),
    });
    let result = f
        .store
        .reattach_terminal_supervisor_with_workspace(
            f.credential.credential(),
            config,
            &f.prior,
            f.project,
            f.installation,
        )
        .await;
    assert!(matches!(result, Err(RuntimeStoreError::Fenced)));
    assert_eq!(f.probe.calls.load(Ordering::SeqCst), 2);
    assert_eq!(before, fixtures::snapshot(&f.window.f.store).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persistent_scoped_membership_work_does_not_scan_each_supervisors_history() {
    persistent_membership_case(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unthrottled_scoped_membership_preserves_the_same_terminal_takeover() {
    persistent_membership_case(false).await;
}

async fn persistent_membership_case(throttle: bool) {
    let f = prepared_restart(false, false, true).await;
    f.probe.throttle_sql.store(throttle, Ordering::SeqCst);
    let config = fixtures::config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: f.retired.supervisor_incarnation().unwrap().into(),
    });
    let started = std::time::Instant::now();
    let result = f
        .store
        .reattach_terminal_supervisor_with_workspace(
            f.credential.credential(),
            config,
            &f.prior,
            f.project,
            f.installation,
        )
        .await;
    eprintln!(
        "persistent handoff result={:?} callbacks={} Root_checks={} elapsed={:?}",
        result.as_ref().err(),
        f.operations.load(Ordering::SeqCst),
        f.probe.calls.load(Ordering::SeqCst),
        started.elapsed()
    );
    let (_, metadata, grant) =
        result.expect("persistent scoped history must fit the unchanged handoff");
    assert_eq!(
        metadata.binding().session_id,
        f.window.roles.deep.session_id
    );
    assert_eq!(grant.generation(), 1);
    assert!(f.probe.calls.load(Ordering::SeqCst) <= 2);
    assert!(f.operations.load(Ordering::SeqCst) < 64);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn borrowed_terminal_handoff_never_opens_a_second_root_channel() {
    let f = prepared_restart(false, false, false).await;
    let before = fixtures::snapshot(&f.window.f.store).await;
    let owned = f
        .installation
        .check_before_writer(&f.store, &f.window.f.owner, &f.window.f.conversation)
        .await
        .unwrap();
    let config = fixtures::config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: f.retired.supervisor_incarnation().unwrap().into(),
    });
    let result = owned
        .reattach_terminal_supervisor_with_workspace(
            f.credential.credential(),
            config,
            &f.prior,
            f.project,
            f.installation,
        )
        .await;
    assert!(matches!(result, Err(RuntimeStoreError::Fenced)));
    assert_eq!(f.probe.calls.load(Ordering::SeqCst), 1);
    assert_eq!(before, fixtures::snapshot(&f.window.f.store).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_original_physical_budget_is_never_restarted() {
    let f = prepared_restart(false, false, false).await;
    f.probe.first_wait_ms.store(4_500, Ordering::SeqCst);
    f.probe.sql_wait_ms.store(800, Ordering::SeqCst);
    let before = fixtures::snapshot(&f.window.f.store).await;
    let config = fixtures::config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: f.retired.supervisor_incarnation().unwrap().into(),
    });
    let result = f
        .store
        .reattach_terminal_supervisor_with_workspace(
            f.credential.credential(),
            config,
            &f.prior,
            f.project,
            f.installation,
        )
        .await;
    assert!(matches!(result, Err(RuntimeStoreError::Fenced)));
    assert_eq!(f.probe.calls.load(Ordering::SeqCst), 1);
    assert_eq!(before, fixtures::snapshot(&f.window.f.store).await);
}
