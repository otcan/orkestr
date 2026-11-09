//! Real closed-window successors must survive one pre-effect handoff expiry.
use super::*;
use crate::production_runtime::workspace::{RootWorkspaceCustody, WorkspaceDirectoryIdentity};
use sqlx::{sqlite::SqlitePoolOptions, Connection, SqliteConnection};
use std::{
    fs::File,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};

struct RootProbe {
    database: PathBuf,
    context: String,
    incarnation: String,
    generation: i64,
    armed: AtomicBool,
    calls: AtomicUsize,
    writer_free: AtomicBool,
    reject_refresh: bool,
    first_wait_ms: AtomicUsize,
    sql_wait_ms: AtomicUsize,
    throttle_sql: AtomicBool,
}
impl RootWorkspaceCustody for RootProbe {
    fn check_original_actor(&self) -> Result<()> {
        Ok(())
    }
    fn check(
        &self,
        paths: &[PathBuf; 3],
        identities: [WorkspaceDirectoryIdentity; 3],
    ) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        for (path, identity) in paths.iter().zip(identities) {
            let metadata = std::fs::symlink_metadata(path).map_err(db)?;
            if !metadata.is_dir()
                || metadata.dev() != identity.device()
                || metadata.ino() != identity.inode()
                || metadata.uid() != identity.uid()
            {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        if !self.armed.load(Ordering::SeqCst) {
            return Ok(());
        }
        assert!(tokio::runtime::Handle::try_current().is_err());
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let database = self.database.clone();
        let context = self.context.clone();
        let expected = (self.incarnation.clone(), self.generation);
        let free = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let options = sqlx::sqlite::SqliteConnectOptions::new()
                        .filename(database)
                        .busy_timeout(Duration::ZERO);
                    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
                    let Ok(mut tx) = connection.begin_with("BEGIN IMMEDIATE").await else {
                        return false;
                    };
                    let current: (String, i64) = sqlx::query_as(
                        "SELECT incarnation_id,generation FROM production_supervisors WHERE context_id=?",
                    )
                    .bind(context)
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
                    assert_eq!(current, expected, "fresh Root check observed unrolled takeover");
                    tx.rollback().await.unwrap();
                    true
                })
        })
        .join()
        .unwrap();
        self.writer_free.store(free, Ordering::SeqCst);
        if !free {
            return Err(RuntimeStoreError::Unavailable);
        }
        if call == 1 {
            std::thread::sleep(Duration::from_millis(
                self.first_wait_ms.load(Ordering::SeqCst) as u64,
            ));
        }
        if call > 1 && self.reject_refresh {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
}

struct Restart {
    window: Window,
    retired: Store,
    credential: ExecutionWindowCredential,
    prior: RunId,
    installation: WorkspaceInstallation,
    project: Uuid,
    probe: Arc<RootProbe>,
    store: Store,
    operations: Arc<AtomicUsize>,
}

fn installation(
    allow: &WorkspaceOperatorAllowlist,
    path: &std::path::Path,
    probe: Arc<RootProbe>,
) -> WorkspaceInstallation {
    let paths = [path.to_path_buf(), path.join(".git"), path.join(".git")];
    let descriptors = paths.clone().map(|p| File::open(p).unwrap().into());
    allow
        .installation_from_root(paths, descriptors, probe)
        .unwrap()
}

async fn root_window() -> (
    Window,
    WorkspaceOperatorAllowlist,
    PathBuf,
    Uuid,
    Arc<RootProbe>,
) {
    use std::os::unix::fs::MetadataExt;
    let f = fixtures::setup().await;
    let context = f.handle.authority.as_ref().unwrap();
    let probe = Arc::new(RootProbe {
        database: f.root.join("core.sqlite3"),
        context: context.id.clone(),
        incarnation: context.incarnation.clone(),
        generation: context.generation,
        armed: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
        writer_free: AtomicBool::new(false),
        reject_refresh: false,
        first_wait_ms: AtomicUsize::new(0),
        sql_wait_ms: AtomicUsize::new(150),
        throttle_sql: AtomicBool::new(true),
    });
    let browser = browser(&f).await;
    let mut roles = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap();
    let path = f.root.with_extension("workspace");
    std::fs::create_dir_all(path.join(".git")).unwrap();
    let allow = WorkspaceOperatorAllowlist::new(
        vec![path.clone()],
        vec![f.root.clone()],
        std::fs::metadata(&path).unwrap().uid(),
    )
    .unwrap();
    let project = Uuid::new_v4();
    let grant = f
        .handle
        .register_workspace(
            &f.token,
            &f.conversation,
            project,
            installation(&allow, &path, probe.clone()),
        )
        .await
        .unwrap();
    for binding in [&roles.deep, &roles.fast] {
        f.handle
            .bind_workspace_session(&f.token, &grant, binding)
            .await
            .unwrap();
    }
    roles.deep = fixtures::ready(&f).await;
    let old = input(&f, "old-handoff-input").await;
    let source = input(&f, "initial-handoff-input").await;
    let status = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &source)
        .await
        .unwrap()
        .status;
    let credential = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            status.window_id,
            1,
            "role-test-boot",
            status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    let bound = f
        .handle
        .bind_execution_window(&f.token, &credential)
        .await
        .unwrap();
    bound
        .register_workspace(
            credential.credential(),
            &f.conversation,
            project,
            installation(&allow, &path, probe.clone()),
        )
        .await
        .unwrap();
    (
        Window {
            f,
            browser_credential: browser,
            bound,
            credential,
            status,
            roles,
            old,
            source,
        },
        allow,
        path,
        project,
        probe,
    )
}

async fn prepared_restart(always_slow: bool, reject_refresh: bool, work_rate: bool) -> Restart {
    let (w, allow, path, project, probe) = root_window().await;
    let fast = w.ready_fast().await;
    w.activate().await;
    let fast_run = w
        .bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: w.source.input_message_id.clone(),
                source_event_id: w.source.input_event_id.clone(),
                fast_binding_id: fast.session_id,
                expected_binding_generation: fast.generation,
                request_key: "handoff-fast".into(),
            },
        )
        .await
        .unwrap();
    let fast = w.consume(&fast_run).await;
    let claim = w
        .bound
        .claim_next(
            &w.f.owner,
            &w.f.conversation,
            &w.roles.deep.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let deep = w
        .bound
        .admit_run(
            &claim,
            &w.roles.deep.session_id,
            w.roles.deep.generation,
            "handoff-deep",
        )
        .await
        .unwrap();
    let deep = w.consume(&deep).await;
    accept(&w, fast.provider(), "handoff-accept-fast").await;
    accept(&w, deep.provider(), "handoff-accept-deep").await;
    w.bound
        .begin_execution_window_retirement(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot",
        )
        .await
        .unwrap();
    w.bound
        .retire_terminal_supervisor(w.credential.credential(), &deep.provider().run.run_id)
        .await
        .unwrap();
    let (retired, handoff) = w
        .bound
        .retire_execution_window(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot",
            &deep.provider().run.run_id,
        )
        .await
        .unwrap();
    let mut request = input(&w.f, "handoff-next").await;
    request.expected_generation = 1;
    request.predecessor_window_id = Some(w.status.window_id);
    let next = w
        .f
        .store
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &request)
        .await
        .unwrap();
    let credential = retired
        .issue_execution_window_credential(
            handoff.credential(),
            next.status.window_id,
            2,
            "role-test-boot",
            next.status.expires_at_ms,
            &"b".repeat(64),
        )
        .await
        .unwrap();
    if work_rate {
        // Other conversations may own many independent supervisor scopes.
        // They have no windows/readiness in this conversation and must not
        // multiply the cost of its existential membership checks.
        sqlx::query("WITH RECURSIVE history(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM history WHERE n<8192) INSERT INTO production_supervisors(context_id,owner_id,provider_kind,namespace,supervisor_key,incarnation_id,generation,lease_deadline_ms) SELECT printf('10000000-0000-4000-8000-%012x',n),?,'codex',printf('synthetic-unrelated-%d',n),'other-supervisor',printf('20000000-0000-4000-8000-%012x',n),1,1 FROM history")
            .bind(w.f.owner.to_string()).execute(&w.f.store.pool).await.unwrap();
    }
    // All bootstrap callbacks have finished before this per-operation policy
    // flag is installed; only the final trusted installation retains it.
    let probe = Arc::new(RootProbe {
        database: probe.database.clone(),
        context: probe.context.clone(),
        incarnation: probe.incarnation.clone(),
        generation: probe.generation,
        armed: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
        writer_free: AtomicBool::new(false),
        reject_refresh,
        first_wait_ms: AtomicUsize::new(0),
        sql_wait_ms: AtomicUsize::new(150),
        throttle_sql: AtomicBool::new(true),
    });
    let installation = installation(&allow, &path, probe.clone());
    probe.armed.store(true, Ordering::SeqCst);
    let observed = Arc::new(AtomicUsize::new(0));
    let operations = Arc::new(AtomicUsize::new(0));
    let counted = operations.clone();
    let hook = probe.clone();
    let mut store = w.f.store.clone();
    store.pool = SqlitePoolOptions::new()
        .max_connections(1)
        .before_acquire(move |connection, _| {
            let probe = hook.clone();
            let observed = observed.clone();
            let counted = counted.clone();
            Box::pin(async move {
                let attempt = probe.calls.load(Ordering::SeqCst);
                if attempt > 0 && observed.swap(attempt, Ordering::SeqCst) != attempt {
                    let delayed = AtomicBool::new(false);
                    let wait_ms = probe.sql_wait_ms.load(Ordering::SeqCst);
                    let throttle_sql = probe.throttle_sql.load(Ordering::SeqCst);
                    connection.lock_handle().await?.set_progress_handler(
                        if work_rate { 1_000 } else { 1 },
                        move || {
                            counted.fetch_add(1, Ordering::SeqCst);
                            if work_rate && throttle_sql {
                                std::thread::sleep(Duration::from_micros(100));
                            } else if !work_rate
                                && (always_slow || attempt == 1)
                                && !delayed.swap(true, Ordering::SeqCst)
                            {
                                // Real SQL work after Root attestation crosses the
                                // unchanged 100ms deadline once (or on every attempt).
                                std::thread::sleep(Duration::from_millis(wait_ms as u64));
                            }
                            true
                        },
                    );
                }
                Ok(true)
            })
        })
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(w.f.root.join("core.sqlite3"))
                .foreign_keys(true),
        )
        .await
        .unwrap();
    Restart {
        prior: deep.provider().run.run_id.clone(),
        window: w,
        retired,
        credential,
        installation,
        project,
        probe,
        store,
        operations,
    }
}

#[path = "terminal_handoff_cases.rs"]
mod cases;

#[path = "terminal_membership_tests.rs"]
mod membership;
