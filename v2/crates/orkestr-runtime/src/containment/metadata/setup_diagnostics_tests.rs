//! The real metadata setup bridge observes only after both fences have left.
use super::*;
use std::sync::mpsc::sync_channel;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_setup_polls_do_not_emit_diagnostics() {
    let c = Case::new().await;
    let result = c.authority.shared.setup_observed(
        || Ok(17),
        |_| panic!("successful metadata poll emitted diagnostics"),
    );
    assert_eq!(result.unwrap(), 17);
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blocked_failure_observer_releases_metadata_gate_and_database_writer() {
    let c = Case::new().await;
    c.store.revoke_session(&"ab".repeat(32)).await.unwrap();
    let shared = c.authority.shared.clone();
    let (entered, waiting) = sync_channel(1);
    let (release, released) = sync_channel(1);
    let observer = std::thread::spawn(move || {
        shared.setup_observed(
            || -> std::result::Result<(), Error> {
                panic!("revoked setup invoked metadata action")
            },
            |diagnostics| {
                entered.send(()).unwrap();
                released.recv().unwrap();
                diagnostics.emit();
            },
        )
    });
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    let metadata_free = c.authority.shared.state.try_lock().is_ok();
    // This ordinary public API takes BEGIN IMMEDIATE before rejecting the
    // revoked issuer. Completion proves diagnostic output retains no writer.
    let writer = tokio::time::timeout(
        Duration::from_secs(2),
        c.bound.authorize_session_metadata(&c.binding),
    )
    .await;
    release.send(()).unwrap();
    assert!(matches!(observer.join().unwrap(), Err(Error::Revoked)));
    assert!(metadata_free, "diagnostic observer retained metadata gate");
    assert!(matches!(
        writer.expect("diagnostic observer retained SQLite writer"),
        Err(RuntimeStoreError::Unauthorized)
    ));
    c.cleanup().await;
}
