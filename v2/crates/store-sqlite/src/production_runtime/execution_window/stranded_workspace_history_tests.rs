//! A consumed, never-observed Deep may lapse and resume with its workspace.
use super::*;
use crate::production_runtime::{
    RootWorkspaceCustody, WorkspaceDirectoryIdentity, WorkspaceOperatorAllowlist,
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::{
    fs::File,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

struct RootCheck {
    checks: AtomicUsize,
    probe_database: Mutex<Option<PathBuf>>,
    writer_available: AtomicBool,
}
impl RootWorkspaceCustody for RootCheck {
    fn check_original_actor(&self) -> Result<()> {
        Ok(())
    }
    fn check(
        &self,
        paths: &[PathBuf; 3],
        identities: [WorkspaceDirectoryIdentity; 3],
    ) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        self.checks.fetch_add(1, Ordering::SeqCst);
        if let Some(database) = self.probe_database.lock().unwrap().clone() {
            use sqlx::Connection;
            let available = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let mut connection = sqlx::SqliteConnection::connect_with(
                        &SqliteConnectOptions::new()
                            .filename(database)
                            .busy_timeout(Duration::ZERO),
                    )
                    .await
                    .unwrap();
                    let available = match connection.begin_with("BEGIN IMMEDIATE").await {
                        Ok(tx) => {
                            tx.rollback().await.unwrap();
                            true
                        }
                        Err(_) => false,
                    };
                    available
                });
            self.writer_available.fetch_and(available, Ordering::SeqCst);
        }
        for (path, identity) in paths.iter().zip(identities) {
            let m = std::fs::symlink_metadata(path).map_err(db)?;
            if !m.is_dir()
                || m.dev() != identity.device()
                || m.ino() != identity.inode()
                || m.uid() != identity.uid()
            {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        Ok(())
    }
}

fn installation(f: &fixtures::Case, check: Arc<RootCheck>) -> WorkspaceInstallation {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let root = f.root.with_extension("project");
    std::fs::create_dir_all(root.join(".git")).unwrap();
    for p in [&root, &root.join(".git")] {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o750)).unwrap();
    }
    let allowlist = WorkspaceOperatorAllowlist::new(
        vec![root.clone()],
        vec![f.root.clone()],
        std::fs::metadata(&root).unwrap().uid(),
    )
    .unwrap();
    let paths = [root.clone(), root.join(".git"), root.join(".git")];
    let descriptors = paths.clone().map(|p| File::open(p).unwrap().into());
    allowlist
        .installation_from_root(paths, descriptors, check)
        .unwrap()
}

async fn unrelated_history(f: &fixtures::Case, template: &RunId) {
    let conversation = Uuid::new_v4().to_string();
    let context = Uuid::new_v4().to_string();
    let incarnation = Uuid::new_v4().to_string();
    let session = Uuid::new_v4().to_string();
    let mut tx = f.store.pool.begin().await.unwrap();
    sqlx::query("INSERT INTO conversations(id,owner_id,standalone) VALUES(?,?,1)")
        .bind(&conversation)
        .bind(f.owner.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO production_supervisors(context_id,owner_id,provider_kind,namespace,supervisor_key,incarnation_id,generation,lease_deadline_ms) VALUES(?,?,'codex','synthetic-history','synthetic-history',?,1,0)")
        .bind(&context).bind(f.owner.to_string()).bind(&incarnation).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role,provider_kind,provider_namespace,native_session_id,generation,state) VALUES(?,?,?,'deep','codex','synthetic-history','synthetic-history-native',2,'ready')")
        .bind(&session).bind(f.owner.to_string()).bind(&conversation).execute(&mut *tx).await.unwrap();
    let columns: Vec<String> = sqlx::query("PRAGMA table_info(production_runs)")
        .fetch_all(&mut *tx)
        .await
        .unwrap()
        .iter()
        .map(|r| r.get("name"))
        .collect();
    let expressions = columns
        .iter()
        .map(|column| match column.as_str() {
            "id" => "printf('00000000-0000-4000-8000-%012x',n)".to_owned(),
            "context_id" => "?1".to_owned(),
            "incarnation_id" => "?2".to_owned(),
            "conversation_id" => "?3".to_owned(),
            "session_id" => "?4".to_owned(),
            "native_session_id" => "'synthetic-history-native'".to_owned(),
            "scope_sequence" => "n".to_owned(),
            "request_key" => "printf('synthetic-history:%d',n)".to_owned(),
            "binding_generation" => "1".to_owned(),
            "state" => "'cancelled'".to_owned(),
            _ => format!("r.{column}"),
        })
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("WITH RECURSIVE history(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM history WHERE n<16384) INSERT INTO production_runs({}) SELECT {expressions} FROM production_runs r CROSS JOIN history WHERE r.id=?5", columns.join(","));
    sqlx::query(&sql)
        .bind(context)
        .bind(incarnation)
        .bind(conversation)
        .bind(session)
        .bind(template.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

async fn workspace_window(check: Arc<RootCheck>) -> (Window, WorkspaceGrant) {
    let f = fixtures::setup().await;
    let browser_credential = browser(&f).await;
    let mut roles = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap();
    // Installation precedes Native confirmation: registration may never add
    // authority retroactively to an already established child.
    let project = f
        .handle
        .register_workspace(
            &f.token,
            &f.conversation,
            Uuid::new_v4(),
            installation(&f, check),
        )
        .await
        .unwrap();
    f.handle
        .bind_workspace_session(&f.token, &project, &roles.deep)
        .await
        .unwrap();
    roles.deep = fixtures::ready(&f).await;
    let old = input(&f, "old-unadmitted-workspace-input").await;
    let source = input(&f, "explicit-workspace-window-input").await;
    let status = f
        .store
        .admit_execution_window_authenticated(&browser_credential, &f.conversation, &source)
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
    (
        Window {
            f,
            browser_credential,
            bound,
            credential,
            status,
            roles,
            old,
            source,
        },
        project,
    )
}

#[derive(Clone, Copy)]
enum HandoffCase {
    Normal,
    Expire,
    ExpireTwice,
    Borrowed,
    Effect,
    Drift,
}
async fn lapsed_restart_case(throttle: bool) {
    lapsed_restart_with_fault(throttle, HandoffCase::Normal).await;
}
async fn lapsed_restart_with_fault(throttle: bool, fault: HandoffCase) {
    let check = Arc::new(RootCheck {
        checks: AtomicUsize::new(0),
        probe_database: Mutex::new(None),
        writer_available: AtomicBool::new(true),
    });
    let (w, _project) = workspace_window(check.clone()).await;
    w.activate().await;
    let deep = deep_dispatch(&w, "unobserved-lapsed-deep")
        .await
        .provider()
        .clone();
    // A real consumed dispatch, with no Started/progress/proposal observation.
    assert_eq!(
        count(&w.f.store, "SELECT count(*) FROM production_observations").await,
        0
    );
    expire(&w.f.store, &deep).await;
    let fresh = restart_window(&w, w.status.window_id, 1).await;
    assert_eq!(
        settle(&fresh, &w, w.status.window_id, 1).await,
        vec![deep.run.run_id.clone()]
    );
    let closed = reconcile(&fresh, &w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(closed.outcome, Outcome::Failed);
    assert_eq!(closed.prior_run_id, Some(deep.run.run_id.clone()));
    assert_eq!(
        scalar(
            &fresh,
            "SELECT prior_state FROM production_run_lapses WHERE run_id=?",
            &deep.run.run_id.to_string()
        )
        .await,
        "starting"
    );
    unrelated_history(&w.f, &deep.run.run_id).await;
    let retired = fresh
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    let mut request = input(&w.f, "new-source-after-lapse").await;
    request.expected_generation = 1;
    request.predecessor_window_id = Some(w.status.window_id);
    let admission = fresh
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &request)
        .await
        .unwrap();
    let credential = retired
        .store()
        .issue_idle_execution_window_credential_authenticated(
            &w.browser_credential,
            admission.status.window_id,
            2,
            "synthetic-successor-boot",
            admission.status.expires_at_ms,
            &"e".repeat(64),
        )
        .await
        .unwrap();
    let selected = installation(&w.f, check.clone());
    let checks = check.checks.load(Ordering::SeqCst);
    let counted = Arc::new(AtomicUsize::new(0));
    let operations = counted.clone();
    let observed = check.clone();
    let mut reopened = fresh.clone();
    reopened.pool = SqlitePoolOptions::new()
        .max_connections(1)
        .before_acquire(move |connection, _| {
            let check = observed.clone();
            let counted = counted.clone();
            Box::pin(async move {
                if check.checks.load(Ordering::SeqCst) > checks {
                    connection
                        .lock_handle()
                        .await?
                        .set_progress_handler(1_000, move || {
                            counted.fetch_add(1, Ordering::SeqCst);
                            if throttle {
                                std::thread::sleep(Duration::from_micros(100));
                            }
                            true
                        });
                }
                Ok(true)
            })
        })
        .connect_with(
            SqliteConnectOptions::new()
                .filename(w.f.root.join("core.sqlite3"))
                .foreign_keys(true),
        )
        .await
        .unwrap();
    use crate::production_runtime::terminal_restart::handoff_test_control::{arm, Fault};
    *check.probe_database.lock().unwrap() = Some(w.f.root.join("core.sqlite3"));
    let before = fixtures::snapshot(&reopened).await;
    let before_checks = check.checks.load(Ordering::SeqCst);
    let armed = match fault {
        // This fixture proves bounded SQLite work, independently of host CPU
        // scheduling. Actual expiry/budget behavior has separate regressions.
        HandoffCase::Normal => Some(arm(&deep.run.run_id, &w.f.conversation, Fault::Expire, 0)),
        HandoffCase::Expire | HandoffCase::Borrowed => {
            Some(arm(&deep.run.run_id, &w.f.conversation, Fault::Expire, 1))
        }
        HandoffCase::ExpireTwice => {
            Some(arm(&deep.run.run_id, &w.f.conversation, Fault::Expire, 2))
        }
        HandoffCase::Effect => Some(arm(
            &deep.run.run_id,
            &w.f.conversation,
            Fault::EffectThenExpire,
            1,
        )),
        HandoffCase::Drift => Some(arm(
            &deep.run.run_id,
            &w.f.conversation,
            Fault::DriftThenExpire(w.f.root.with_extension("project")),
            1,
        )),
    };
    let borrowed = if matches!(fault, HandoffCase::Borrowed) {
        Some(
            selected
                .check_before_writer(&reopened, &w.f.owner, &w.f.conversation)
                .await
                .unwrap(),
        )
    } else {
        None
    };
    let caller = borrowed.as_deref().unwrap_or(&reopened);
    let started = std::time::Instant::now();
    let result = caller
        .reattach_terminal_supervisor_with_workspace(
            credential.credential(),
            fixtures::config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: retired.predecessor_incarnation().into(),
            }),
            &deep.run.run_id,
            sqlx::query_scalar::<_, String>(
                "SELECT id FROM workspace_projects WHERE conversation_id=?",
            )
            .bind(w.f.conversation.to_string())
            .fetch_one(&reopened.pool)
            .await
            .unwrap()
            .parse()
            .unwrap(),
            selected,
        )
        .await;
    eprintln!(
        "lapsed workspace restart result={:?} elapsed={:?} progress_callbacks={}",
        result.as_ref().err(),
        started.elapsed(),
        operations.load(Ordering::SeqCst)
    );
    assert!(
        check.writer_available.load(Ordering::SeqCst),
        "fresh Root IPC ran before writer rollback"
    );
    if let Some(armed) = &armed {
        let attempts = match fault {
            HandoffCase::Normal => 0,
            HandoffCase::ExpireTwice => 2,
            _ => 1,
        };
        assert_eq!(armed.hits(), attempts);
        let root_checks = if matches!(
            fault,
            HandoffCase::Normal | HandoffCase::Borrowed | HandoffCase::Effect
        ) {
            1
        } else {
            2
        };
        assert_eq!(
            check.checks.load(Ordering::SeqCst) - before_checks,
            root_checks
        );
    }
    if matches!(
        fault,
        HandoffCase::ExpireTwice | HandoffCase::Borrowed | HandoffCase::Effect | HandoffCase::Drift
    ) {
        assert!(matches!(result, Err(RuntimeStoreError::Fenced)));
        assert_eq!(fixtures::snapshot(&reopened).await, before);
        return;
    }
    let (_, metadata, grant) = result
        .expect("exact lapsed predecessor with unrelated history must retain its physical handoff");
    assert!(
        operations.load(Ordering::SeqCst) < 64,
        "unrelated history increased physical handoff query work"
    );
    assert_eq!(metadata.binding().session_id, deep.run.session_id);
    assert_eq!(grant.generation(), 1);
    assert_eq!(
        scalar(
            &reopened,
            "SELECT state FROM reasoning_inbox WHERE message_id=?",
            &request.input_message_id.to_string()
        )
        .await,
        "queued"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lapsed_unobserved_deep_workspace_restart_keeps_handoff_bounded() {
    lapsed_restart_case(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lapsed_unobserved_workspace_restart_without_workrate_throttle() {
    lapsed_restart_case(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_run_indexes_upgrade_schema94_without_history_changes() {
    let f = fixtures::setup().await;
    let (prior, decision) = crate::production_runtime::acceptance_tests::proposal(&f).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &decision)
        .await
        .unwrap();
    f.handle
        .retire_terminal_supervisor(&f.token, &prior.run.run_id)
        .await
        .unwrap();
    unrelated_history(&f, &prior.run.run_id).await;
    let before = fixtures::snapshot(&f.store).await;
    // An exact schema-94 fixture: version 95 adds only these two indexes.
    sqlx::raw_sql("DROP TABLE message_revisions; DELETE FROM _sqlx_migrations WHERE version=96; DROP INDEX production_runs_context_lookup; DROP INDEX production_runs_session_generation; DELETE FROM _sqlx_migrations WHERE version=95;")
        .execute(&f.store.pool).await.unwrap();
    let upgraded = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    assert_eq!(fixtures::snapshot(&upgraded).await, before);
    let version: i64 =
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success=1")
            .fetch_one(&upgraded.pool)
            .await
            .unwrap();
    assert_eq!(
        version,
        sqlx::migrate!("./migrations")
            .iter()
            .last()
            .unwrap()
            .version
    );
}

#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
#[path = "stranded_workspace_handoff_tests.rs"]
mod handoff_expiry;
