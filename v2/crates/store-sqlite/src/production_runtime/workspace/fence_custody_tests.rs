//! A slow live Root check must not reserve the shared Core writer.
#[path = "fence_custody_tests/cross_pool.rs"]
mod cross_pool;
#[path = "fence_custody_tests/execution_handoff.rs"]
mod execution_handoff;
#[path = "fence_custody_tests/mutable_workspace.rs"]
mod mutable_workspace;
#[path = "fence_custody_tests/setup_attestation.rs"]
mod setup_attestation;
#[path = "fence_custody_tests/terminal_history.rs"]
mod terminal_history;
#[path = "fence_custody_tests/worker_claim.rs"]
mod worker_claim;
use super::*;
use crate::production_runtime::tests::{claim, setup, Case};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::{
    fs::File,
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};

struct RootCheck {
    database: PathBuf,
    probing: AtomicBool,
    calls: AtomicUsize,
    independent_writer: AtomicBool,
    original_alive: AtomicBool,
    policy_valid: AtomicBool,
    change_during_check: AtomicBool,
    ordinary_write_during_check: AtomicBool,
    physical_checks: AtomicUsize,
}

impl RootWorkspaceCustody for RootCheck {
    fn check_original_actor(&self) -> Result<()> {
        if self.original_alive.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(RuntimeStoreError::Fenced)
        }
    }
    fn check(
        &self,
        paths: &[PathBuf; 3],
        identities: [WorkspaceDirectoryIdentity; 3],
    ) -> Result<()> {
        self.physical_checks.fetch_add(1, Ordering::SeqCst);
        self.check_original_actor()?;
        if !self.policy_valid.load(Ordering::SeqCst) {
            return Err(RuntimeStoreError::Fenced);
        }
        for (path, identity) in paths.iter().zip(identities) {
            use std::os::unix::fs::MetadataExt;
            let current = std::fs::symlink_metadata(path).map_err(db)?;
            if !current.is_dir()
                || current.dev() != identity.device()
                || current.ino() != identity.inode()
                || current.uid() != identity.uid()
            {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        if self
            .ordinary_write_during_check
            .swap(false, Ordering::SeqCst)
        {
            std::fs::write(paths[0].join("ordinary-command-output"), b"output").unwrap();
        }
        if !self.probing.load(Ordering::SeqCst) {
            return Ok(());
        }
        assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "fresh Root callback inherited a Tokio event-loop context"
        );
        self.calls.fetch_add(1, Ordering::SeqCst);
        let database = self.database.clone();
        // An actual separate SQLite connection, with no retry or busy wait.
        // This models unrelated Core traffic while the Root peer is pending.
        let available = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let options = SqliteConnectOptions::new()
                        .filename(database)
                        .busy_timeout(Duration::ZERO);
                    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
                    let available = match connection.begin_with("BEGIN IMMEDIATE").await {
                        Ok(transaction) => {
                            transaction.rollback().await.unwrap();
                            true
                        }
                        Err(_) => false,
                    };
                    available
                })
        })
        .join()
        .unwrap();
        self.independent_writer.store(available, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(1_100));
        if self.change_during_check.load(Ordering::SeqCst) {
            use std::os::unix::fs::PermissionsExt;
            let root = self.database.parent().unwrap().with_extension("project");
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Ok(())
    }
}

fn root_installation(f: &Case, check: Arc<dyn RootWorkspaceCustody>) -> WorkspaceInstallation {
    let (allowlist, root) = super::tests::installation(f);
    let paths = [root.clone(), root.join(".git"), root.join(".git")];
    let descriptors = paths.clone().map(|path| File::open(path).unwrap().into());
    allowlist
        .installation_from_root(paths, descriptors, check)
        .unwrap()
}

fn root_check(f: &Case) -> Arc<RootCheck> {
    Arc::new(RootCheck {
        database: f.root.join("core.sqlite3"),
        probing: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
        independent_writer: AtomicBool::new(false),
        original_alive: AtomicBool::new(true),
        policy_valid: AtomicBool::new(true),
        change_during_check: AtomicBool::new(false),
        ordinary_write_during_check: AtomicBool::new(false),
        physical_checks: AtomicUsize::new(0),
    })
}

async fn prepared(f: &Case) -> (BoundSessionMetadata, Arc<RootCheck>) {
    let check = root_check(f);
    (prepared_with_check(f, check.clone()).await, check)
}

async fn prepared_with_check(
    f: &Case,
    check: Arc<dyn RootWorkspaceCustody>,
) -> BoundSessionMetadata {
    let installation = root_installation(f, check);
    let project = f
        .handle
        .register_workspace(&f.token, &f.conversation, Uuid::new_v4(), installation)
        .await
        .unwrap();
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    f.handle
        .bind_workspace_session(&f.token, &project, &binding)
        .await
        .unwrap();
    f.handle.authorize_session_metadata(&binding).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_root_metadata_attestation_does_not_hold_core_writer() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    check.probing.store(true, Ordering::SeqCst);
    assert_eq!(
        f.handle.with_metadata_fence(&metadata, || Ok::<_, ()>(7)),
        Ok(Ok(7))
    );
    assert_eq!(check.calls.load(Ordering::SeqCst), 1);
    assert!(
        check.independent_writer.load(Ordering::SeqCst),
        "Root attestation held the Core SQLite writer while awaiting its peer"
    );
}

#[test]
fn root_metadata_preflight_outside_tokio_uses_an_isolated_rpc_context() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let (f, metadata, check) = runtime.block_on(async {
        let f = setup().await;
        let (metadata, check) = prepared(&f).await;
        (f, metadata, check)
    });
    drop(runtime);
    check.probing.store(true, Ordering::SeqCst);
    assert_eq!(
        f.handle.with_metadata_fence(&metadata, || Ok::<_, ()>(3)),
        Ok(Ok(3))
    );
    assert_eq!(check.calls.load(Ordering::SeqCst), 1);
    assert!(check.independent_writer.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scoped_proof_is_not_reusable_after_its_owning_guard_drops() {
    let f = setup().await;
    let (metadata, _) = prepared(&f).await;
    let guard = f
        .handle
        .preflight_workspace(&f.owner, &f.conversation)
        .await
        .unwrap();
    let cloned: Store = (*guard).clone();
    drop(guard);
    let mut called = false;
    assert!(cloned
        .with_metadata_fence(&metadata, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_scoped_physical_proof_cannot_authorize_two_action_callbacks() {
    let f = setup().await;
    let (metadata, _) = prepared(&f).await;
    let guard = f
        .handle
        .preflight_workspace(&f.owner, &f.conversation)
        .await
        .unwrap();
    let mut calls = 0;
    assert_eq!(
        guard.with_metadata_fence(&metadata, || {
            calls += 1;
            Ok::<_, ()>(())
        }),
        Ok(Ok(()))
    );
    assert!(guard
        .with_metadata_fence(&metadata, || {
            calls += 1;
            Ok::<_, ()>(())
        })
        .is_err());
    assert_eq!(calls, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mutation_during_fresh_root_verification_never_becomes_accepted_baseline() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    check.probing.store(true, Ordering::SeqCst);
    check.change_during_check.store(true, Ordering::SeqCst);
    let mut called = false;
    assert!(f
        .handle
        .with_metadata_fence(&metadata, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writer_wait_cannot_spend_an_expired_physical_handoff() {
    let f = setup().await;
    let (metadata, _) = prepared(&f).await;
    let guard = f
        .handle
        .preflight_workspace(&f.owner, &f.conversation)
        .await
        .unwrap();
    let writer = f.store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        writer.rollback().await.unwrap();
    });
    let mut called = false;
    assert!(guard
        .with_metadata_fence(&metadata, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
    release.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_revocation_after_physical_preflight_still_fences_the_action() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    let id = sqlx::query_scalar::<_, String>("SELECT id FROM workspace_projects")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let grant = f
        .handle
        .register_workspace(
            &f.token,
            &f.conversation,
            id.parse().unwrap(),
            root_installation(&f, check.clone()),
        )
        .await
        .unwrap();
    let guard = f
        .handle
        .preflight_workspace(&f.owner, &f.conversation)
        .await
        .unwrap();
    f.handle.revoke_workspace(&f.token, &grant).await.unwrap();
    let mut called = false;
    assert!(guard
        .with_metadata_fence(&metadata, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_project_preflight_refuses_a_project_added_before_the_writer() {
    let f = setup().await;
    let guard = f
        .handle
        .preflight_workspace(&f.owner, &f.conversation)
        .await
        .unwrap();
    let (metadata, _) = prepared(&f).await;
    let mut called = false;
    assert!(guard
        .with_metadata_fence(&metadata, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stale_or_wrong_actor_proof_never_invokes_the_action() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    let guard = f
        .handle
        .preflight_workspace(&f.owner, &f.conversation)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(125)).await;
    let mut called = false;
    assert!(guard
        .with_metadata_fence(&metadata, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
    drop(guard);
    let guard = f
        .handle
        .preflight_workspace(&f.owner, &f.conversation)
        .await
        .unwrap();
    check.original_alive.store(false, Ordering::SeqCst);
    assert!(guard
        .with_metadata_fence(&metadata, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn descriptor_attributes_and_git_directory_changes_fence_before_action() {
    use std::os::unix::fs::PermissionsExt;
    let f = setup().await;
    let (metadata, _) = prepared(&f).await;
    let root = f.root.with_extension("project");
    let guard = f
        .handle
        .preflight_workspace(&f.owner, &f.conversation)
        .await
        .unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut called = false;
    assert!(guard
        .with_metadata_fence(&metadata, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
    drop(guard);
    let guard = f
        .handle
        .preflight_workspace(&f.owner, &f.conversation)
        .await
        .unwrap();
    std::fs::rename(root.join(".git"), root.join("prior-git")).unwrap();
    std::fs::create_dir(root.join(".git")).unwrap();
    assert!(guard
        .with_metadata_fence(&metadata, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_reopen_retains_the_installation_of_existing_grants_and_metadata() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    let original = f
        .handle
        .workspace_handles
        .0
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    let id = sqlx::query_scalar::<_, String>("SELECT id FROM workspace_projects")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    f.handle
        .register_workspace(
            &f.token,
            &f.conversation,
            id.parse().unwrap(),
            root_installation(&f, check.clone()),
        )
        .await
        .unwrap();
    let retained = f
        .handle
        .workspace_handles
        .0
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    assert!(Arc::ptr_eq(&original, &retained));
    assert_eq!(
        f.handle.with_metadata_fence(&metadata, || Ok::<_, ()>(1)),
        Ok(Ok(1))
    );
}
