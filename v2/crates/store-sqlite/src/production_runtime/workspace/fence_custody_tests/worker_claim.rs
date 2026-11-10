//! ORK-771: an idle Worker claim takes no physical project check.
use super::*;
use orkestr_v2_contracts::RunId;

/// A Deep run of the conversation that owns the Root-attested project.
async fn parent_run(f: &Case, metadata: BoundSessionMetadata) -> RunId {
    let session = metadata.binding().session_id.clone();
    let ready = f
        .handle
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: session,
                expected_generation: 1,
                native_session_id: "synthetic-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "synthetic-ready".into(),
            },
        )
        .await
        .unwrap();
    let claim = claim(f, ready.binding()).await;
    f.handle
        .admit_run(
            &claim,
            &ready.binding().session_id,
            ready.binding().generation,
            "synthetic-run",
        )
        .await
        .unwrap()
        .provider
        .run
        .run_id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_worker_claim_is_not_fenced_by_a_changing_project() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    let parent = parent_run(&f, metadata).await;
    // Every Root check now refuses, as a project churning under the Worker's
    // own command refuses both attempts of one check.
    check.policy_valid.store(false, Ordering::SeqCst);
    let before = check.physical_checks.load(Ordering::SeqCst);
    for _ in 0..3 {
        assert!(matches!(
            f.handle.claim_worker_task(&f.token, &parent).await,
            Ok(None)
        ));
    }
    assert_eq!(
        check.physical_checks.load(Ordering::SeqCst),
        before,
        "no queued task: no Root check"
    );
}
