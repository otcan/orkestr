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
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

struct RootCheck(AtomicUsize);
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
        self.0.fetch_add(1, Ordering::SeqCst);
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

async fn lapsed_restart_case(throttle: bool) {
    let check = Arc::new(RootCheck(AtomicUsize::new(0)));
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
    let checks = check.0.load(Ordering::SeqCst);
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
                if check.0.load(Ordering::SeqCst) > checks {
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
    let started = std::time::Instant::now();
    let result = reopened
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
    let (_, metadata, grant) = result
        .expect("exact lapsed predecessor with unrelated history must retain its physical handoff");
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
    sqlx::raw_sql("DROP INDEX production_runs_context_lookup; DROP INDEX production_runs_session_generation; DELETE FROM _sqlx_migrations WHERE version=95;")
        .execute(&f.store.pool).await.unwrap();
    let upgraded = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    assert_eq!(fixtures::snapshot(&upgraded).await, before);
    let version: i64 =
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success=1")
            .fetch_one(&upgraded.pool)
            .await
            .unwrap();
    assert_eq!(version, 95);
}
