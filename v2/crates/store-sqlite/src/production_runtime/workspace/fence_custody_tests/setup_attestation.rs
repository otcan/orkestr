//! ORK-770: one setup pays one fresh Root check; a real change still fences.
use super::*;
use std::time::Instant;

/// The server's readiness budget for one setup (owned_execution/bootstrap.rs).
const READINESS_BUDGET: Duration = Duration::from_secs(15);
/// Fewer fences than one real readiness handshake makes: the broker open,
/// then a flush, a poll and an enqueue for each of initialize, initialized,
/// account and thread, polled every 10 ms while each answer is pending.
const SETUP_FENCES: usize = 16;

fn fence(f: &Case, metadata: &BoundSessionMetadata) -> (bool, bool) {
    let mut called = false;
    let ok = f
        .handle
        .with_metadata_fence(metadata, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_ok_and(|inner| inner.is_ok());
    (ok, called)
}

fn checks(check: &RootCheck) -> usize {
    check.physical_checks.load(Ordering::SeqCst)
}

/// Other windows of a burst opening at the same moment: each holds Core's
/// single SQLite writer for one transaction, back to back, from its own
/// connection. Returns once the first transaction holds the writer.
/// `while_held` runs at the end of each transaction, before its commit.
fn core_writer_burst(
    f: &Case,
    windows: usize,
    hold: Duration,
    while_held: impl Fn() + Send + 'static,
) -> std::thread::JoinHandle<()> {
    let database = f.root.join("core.sqlite3");
    let (held, holding) = std::sync::mpsc::channel();
    let burst = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let options = SqliteConnectOptions::new()
                    .filename(database)
                    .busy_timeout(Duration::from_secs(5));
                let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
                for window in 0..windows {
                    let transaction = connection.begin_with("BEGIN IMMEDIATE").await.unwrap();
                    if window == 0 {
                        held.send(()).unwrap();
                    }
                    std::thread::sleep(hold);
                    while_held();
                    transaction.commit().await.unwrap();
                }
            });
    });
    holding.recv().unwrap();
    burst
}

/// One setup fence with its diagnostics: (succeeded, action ran, output).
fn observed_fence(f: &Case, metadata: &BoundSessionMetadata) -> (bool, bool, String) {
    let mut called = false;
    let (result, diagnostics) = f.handle.with_metadata_fence_diagnostics(metadata, || {
        called = true;
        Ok::<_, ()>(())
    });
    let mut output = Vec::new();
    diagnostics.emit_to(&mut output);
    (
        matches!(result, Ok(Ok(()))),
        called,
        String::from_utf8(output).unwrap(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_setup_fence_queued_behind_a_burst_of_opening_windows_still_runs() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    // The setup's first fence takes its fresh Root check, as live.
    assert_eq!(fence(&f, &metadata), (true, true));
    let before = checks(&check);
    // Three windows open together and keep the writer for 150 ms each: far
    // longer, in total, than one 100 ms handoff.
    let burst = core_writer_burst(&f, 3, Duration::from_millis(150), || {});
    let started = Instant::now();
    let (ok, called, output) = observed_fence(&f, &metadata);
    let waited = started.elapsed();
    burst.join().unwrap();
    assert!(
        waited >= Duration::from_millis(100),
        "the fence did not queue behind the burst ({waited:?})"
    );
    assert!(
        ok && called,
        "a setup fence failed only because it queued for Core's writer: {output}"
    );
    assert_eq!(
        checks(&check),
        before,
        "no Root check was taken for, or under, the writer"
    );
    // The setup goes on as usual once the burst is over.
    assert_eq!(fence(&f, &metadata), (true, true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_project_change_while_the_fence_queues_still_fences() {
    let f = setup().await;
    let (metadata, _) = prepared(&f).await;
    assert_eq!(fence(&f, &metadata), (true, true));
    // The project changes while the fence waits for the writer.
    let project = f.root.with_extension("project");
    let burst = core_writer_burst(&f, 1, Duration::from_millis(300), move || {
        std::fs::write(project.join("written-while-queued"), b"output").unwrap();
    });
    let (ok, called, output) = observed_fence(&f, &metadata);
    burst.join().unwrap();
    assert!(
        !ok && !called,
        "a change made while the fence queued was accepted: {output}"
    );
    assert!(
        output.contains("outcome=fenced reason=workspace_stamp_changed"),
        "{output}"
    );
}

fn confirmation(metadata: &BoundSessionMetadata) -> NativeSessionConfirmation {
    NativeSessionConfirmation {
        session_id: metadata.binding().session_id.clone(),
        expected_generation: 1,
        native_session_id: "synthetic-native".into(),
        protocol_version: "codex-rpc-1".into(),
        source_event_key: "synthetic-ready".into(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_root_check_no_longer_pushes_setup_past_its_readiness_budget() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    // Every Root check now takes over a second, as on the loaded host.
    check.probing.store(true, Ordering::SeqCst);
    let before = checks(&check);
    let started = Instant::now();
    for _ in 0..SETUP_FENCES {
        assert_eq!(fence(&f, &metadata), (true, true));
    }
    let elapsed = started.elapsed();
    assert!(
        elapsed < READINESS_BUDGET,
        "{SETUP_FENCES} setup fences took {elapsed:?}"
    );
    assert_eq!(checks(&check) - before, 1, "one fresh Root check per setup");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_swapped_git_directory_fences_the_next_setup_fence() {
    let f = setup().await;
    let (metadata, _) = prepared(&f).await;
    assert_eq!(fence(&f, &metadata), (true, true));
    let project = f.root.with_extension("project");
    std::fs::rename(project.join(".git"), project.join("old-git")).unwrap();
    std::fs::create_dir(project.join(".git")).unwrap();
    assert_eq!(fence(&f, &metadata), (false, false));
    // Which check refused is named.
    let (result, diagnostics) = f
        .handle
        .with_metadata_fence_diagnostics(&metadata, || -> std::result::Result<(), ()> {
            panic!("a swapped project invoked a setup action")
        });
    assert!(matches!(result, Err(RuntimeStoreError::Fenced)));
    let mut output = Vec::new();
    diagnostics.emit_to(&mut output);
    let output = String::from_utf8(output).unwrap();
    assert!(
        output.contains(
            "stage=WorkspacePreflight role=Deep outcome=fenced reason=workspace_root_check"
        ),
        "{output}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_project_output_repeats_the_root_check_instead_of_fencing() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    assert_eq!(fence(&f, &metadata), (true, true));
    let before = checks(&check);
    let project = f.root.with_extension("project");
    std::fs::write(project.join("ordinary-command-output"), b"output").unwrap();
    assert_eq!(fence(&f, &metadata), (true, true));
    assert_eq!(
        checks(&check) - before,
        1,
        "the changed stamp took a fresh check"
    );
    assert_eq!(fence(&f, &metadata), (true, true));
    assert_eq!(checks(&check) - before, 1, "the new evidence serves again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_root_actor_or_revoked_project_fences_the_next_setup_fence() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    assert_eq!(fence(&f, &metadata), (true, true));
    check.original_alive.store(false, Ordering::SeqCst);
    assert_eq!(fence(&f, &metadata), (false, false));
    check.original_alive.store(true, Ordering::SeqCst);
    assert_eq!(fence(&f, &metadata), (true, true));
    sqlx::query("UPDATE workspace_projects SET active=0")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(
        fence(&f, &metadata),
        (false, false),
        "durable row still fences"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lapsed_attestation_takes_a_fresh_check() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    assert_eq!(fence(&f, &metadata), (true, true));
    let before = checks(&check);
    assert_eq!(fence(&f, &metadata), (true, true));
    assert_eq!(checks(&check), before);
    metadata.setup_workspace.lapse_for_test();
    assert_eq!(fence(&f, &metadata), (true, true));
    assert_eq!(checks(&check) - before, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_root_policy_change_is_never_confirmed() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    assert_eq!(fence(&f, &metadata), (true, true));
    // Root-side policy is invisible to the local checks: the attested evidence
    // still serves until it lapses (SETUP_ATTESTATION) ...
    check.policy_valid.store(false, Ordering::SeqCst);
    assert_eq!(fence(&f, &metadata), (true, true));
    // ... and readiness is never confirmed on it.
    let before = checks(&check);
    let confirmation = confirmation(&metadata);
    assert!(f
        .handle
        .confirm_metadata_session(metadata, confirmation)
        .await
        .is_err());
    assert!(
        checks(&check) > before,
        "confirmation took its own Root check"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_root_policy_change_fences_once_the_attestation_lapses() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    assert_eq!(fence(&f, &metadata), (true, true));
    check.policy_valid.store(false, Ordering::SeqCst);
    metadata.setup_workspace.lapse_for_test();
    assert_eq!(fence(&f, &metadata), (false, false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readiness_confirmation_keeps_its_fresh_root_check() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    assert_eq!(fence(&f, &metadata), (true, true));
    assert_eq!(fence(&f, &metadata), (true, true));
    let before = checks(&check);
    let confirmation = confirmation(&metadata);
    f.handle
        .confirm_metadata_session(metadata, confirmation)
        .await
        .unwrap();
    assert!(checks(&check) > before);
}
