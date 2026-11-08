use super::*;
use std::os::unix::fs::MetadataExt;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changed_explicit_scoped_proof_is_not_silently_refreshed() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    let project = f.root.with_extension("project");
    let identity = |m: std::fs::Metadata| (m.dev(), m.ino(), m.uid(), m.gid(), m.mode());
    let before = identity(project.metadata().unwrap());
    let checks = check.physical_checks.load(Ordering::SeqCst);
    let guard = f
        .handle
        .preflight_workspace(&f.owner, &f.conversation)
        .await
        .unwrap();
    // A concurrently running, already-authorized command can publish its output
    // after the fresh Root check and before this separate bounded pipe flush.
    std::fs::write(project.join("ordinary-command-output"), b"output").unwrap();
    assert_eq!(identity(project.metadata().unwrap()), before);
    let mut calls = 0;
    assert_eq!(
        guard.with_metadata_fence(&metadata, || {
            calls += 1;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Fenced)
    );
    assert_eq!(calls, 0);
    assert_eq!(check.physical_checks.load(Ordering::SeqCst) - checks, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_child_file_creation_during_root_check_preserves_authority() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    let project = f.root.with_extension("project");
    let identity = |m: std::fs::Metadata| (m.dev(), m.ino(), m.uid(), m.gid(), m.mode());
    let before = identity(project.metadata().unwrap());
    let physical_checks = check.physical_checks.load(Ordering::SeqCst);
    check
        .ordinary_write_during_check
        .store(true, Ordering::SeqCst);
    let mut calls = 0;
    let result = f.handle.with_metadata_fence(&metadata, || {
        calls += 1;
        Ok::<_, ()>(())
    });
    assert_eq!(identity(project.metadata().unwrap()), before);
    assert_eq!(
        std::fs::read(project.join("ordinary-command-output")).unwrap(),
        b"output"
    );
    assert_eq!(result, Ok(Ok(())));
    assert_eq!(calls, 1);
    assert_eq!(
        check.physical_checks.load(Ordering::SeqCst) - physical_checks,
        2
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_actor_refusal_is_not_retried_or_used_for_an_action() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    let physical_checks = check.physical_checks.load(Ordering::SeqCst);
    check.original_alive.store(false, Ordering::SeqCst);
    let mut calls = 0;
    assert!(f
        .handle
        .with_metadata_fence(&metadata, || {
            calls += 1;
            Ok::<_, ()>(())
        })
        .is_err());
    assert_eq!(calls, 0);
    assert_eq!(
        check.physical_checks.load(Ordering::SeqCst) - physical_checks,
        1
    );
}

struct SlowCheck(AtomicBool);
impl RootWorkspaceCustody for SlowCheck {
    fn check_original_actor(&self) -> Result<()> {
        Ok(())
    }
    fn check(&self, _: &[PathBuf; 3], _: [WorkspaceDirectoryIdentity; 3]) -> Result<()> {
        if self.0.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(7));
        }
        Ok(())
    }
}

#[test]
fn outside_tokio_deadline_discards_late_read_only_proof_without_waiting_for_shutdown() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let (f, metadata, check) = runtime.block_on(async {
        let f = setup().await;
        let check = Arc::new(SlowCheck(AtomicBool::new(false)));
        let metadata = prepared_with_check(&f, check.clone()).await;
        (f, metadata, check)
    });
    drop(runtime);
    check.0.store(true, Ordering::SeqCst);
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut called = false;
        let result = f.handle.with_metadata_fence(&metadata, || {
            called = true;
            Ok::<_, ()>(())
        });
        let _ = sender.send((result, called));
    });
    let (result, called) = receiver
        .recv_timeout(Duration::from_millis(6_500))
        .expect("physical operation deadline waited for the timed-out Root thread");
    assert_eq!(result, Err(RuntimeStoreError::Unavailable));
    assert!(!called);
}
