//! Actual nonblocking socket bytes survive an injected transaction refusal.
use super::*;
use crate::production_runtime::tests::{claim, ready, setup, snapshot};
use std::io::{Read, Write};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn post_action_rollback_returns_no_value_and_preserves_consumed_unknown() {
    let mut f = setup().await;
    let binding = ready(&f).await;
    let claim = claim(&f, &binding).await;
    let run = f
        .handle
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "failure-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&run, "reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) =
        f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    let before = snapshot(&f.store).await;
    let marker = f.root.join("post-action-failure");
    f.handle
        .production_arm_checkpoint(
            crate::ProductionCheckpoint::ExecutionFenceAfterActionRollback,
            marker.clone(),
        )
        .await
        .unwrap();
    let (mut writer, mut reader) = std::os::unix::net::UnixStream::pair().unwrap();
    writer.set_nonblocking(true).unwrap();
    reader.set_nonblocking(true).unwrap();
    let suffix = b"synthetic-provider-suffix\n";
    let mut calls = 0;
    let result = f.handle.with_execution_fence(cap.provider(), || {
        calls += 1;
        writer.write(suffix)
    });
    assert!(matches!(result, Err(RuntimeStoreError::Unavailable)));
    assert_eq!(calls, 1);
    let mut bytes = [0; 128];
    let count = reader.read(&mut bytes).unwrap();
    assert_eq!(&bytes[..count], suffix);
    assert_eq!(
        std::fs::read(marker).unwrap(),
        b"execution-fence-after-action-rollback"
    );
    assert_eq!(snapshot(&f.store).await, before);
    // Reopen authenticates durable uncertainty, not permission to retransmit.
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&other).await.unwrap();
    assert!(matches!(
        attached.consume_execution(&reservation).await.unwrap(),
        ExecutionConsumption::ReconciliationRequired
    ));
    assert!(matches!(
        attached
            .claim_provider_dispatch(&run, "replacement")
            .await
            .unwrap(),
        DispatchClaimResult::ReconciliationRequired
    ));
    assert_eq!(snapshot(&other).await, before);
    other.close().await;
}
