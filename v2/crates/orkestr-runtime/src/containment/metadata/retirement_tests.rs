//! Actual original synthetic children, no provider or account traffic.
use super::*;

async fn broker() -> Case {
    let code = "import sys; print('ready', flush=True); sys.stdin.buffer.read(); sys.exit(73)";
    let c = Case::with_program(
        Path::new("/usr/bin/python3"),
        &[
            "-I".into(),
            "-S".into(),
            "-B".into(),
            "-c".into(),
            code.into(),
        ],
    )
    .await;
    let child = c.child.as_ref().unwrap();
    // The production marker is set only by the trusted broker launcher.
    child.process.broker_launcher.store(true, Ordering::Release);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.poll_stdout().unwrap() {
            Output::Frame(frame) => {
                assert_eq!(frame, b"ready");
                break;
            }
            Output::Pending => {}
            Output::Eof => panic!("synthetic original exited early"),
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    c
}

async fn wait(
    retiring: &mut retirement::RetiringMetadata,
) -> std::result::Result<retirement::ReapedMetadata, Error> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(proof) = retiring.poll_reaped()? {
            return Ok(proof);
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_during_unconfirmed_setup_keeps_exact_child_until_eof_and_wait() {
    let mut c = broker().await;
    let mut child = c.child.take().unwrap();
    child.broker_launcher = true;
    let mut retiring = child.retire_broker().unwrap();
    // Revoking the old authority cannot kill the transferred cleanup owner.
    c.authority.revoke().unwrap();
    let proof = wait(&mut retiring).await.unwrap();
    assert_eq!(proof.binding(), &c.binding);
    assert_eq!(proof.namespace(), "subscription:local");
    assert!(matches!(retiring.poll_reaped(), Err(Error::Revoked)));
    assert_eq!(c.authority.shared.active.load(Ordering::Acquire), 0);
    drop(retiring);
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn window_due_after_ready_but_before_dispatch_has_metadata_only_cleanup_proof() {
    let mut c = broker().await;
    let mut child = c.child.take().unwrap();
    child.broker_launcher = true;
    let ready = child
        .confirm(NativeSessionConfirmation {
            session_id: c.binding.session_id.clone(),
            expected_generation: c.binding.generation,
            native_session_id: "synthetic-unused-native".into(),
            protocol_version: "synthetic-1".into(),
            source_event_key: "unused-ready".into(),
        })
        .await
        .unwrap();
    let mut retiring = ready.retire_broker().unwrap();
    c.authority.revoke().unwrap();
    let proof = wait(&mut retiring).await.unwrap();
    assert_eq!(proof.binding().session_id, c.binding.session_id);
    assert_eq!(c.authority.shared.active.load(Ordering::Acquire), 0);
    drop(retiring);
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn raw_or_failed_setup_never_returns_a_cleanup_witness() {
    let mut raw = broker().await;
    // A raw executor cannot gain proof from an asserted exit73.
    assert!(matches!(
        raw.child.take().unwrap().retire_broker(),
        Err(Error::AuthorityProtocol)
    ));
    raw.cleanup().await;
    let mut failed = broker().await;
    failed.authority.revoke().unwrap();
    let mut child = failed.child.take().unwrap();
    child.broker_launcher = true;
    assert!(matches!(child.retire_broker(), Err(Error::Revoked)));
    failed.cleanup().await;
}
