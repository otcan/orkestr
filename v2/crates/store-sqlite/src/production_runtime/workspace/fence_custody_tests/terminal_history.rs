//! Unrelated retained history must not consume a fresh physical handoff.
use super::*;
use crate::production_runtime::{acceptance_tests::proposal, tests::config};
use orkestr_v2_contracts::RunId;
use sqlx::sqlite::SqlitePoolOptions;

async fn unrelated_history(f: &Case, template: &RunId) {
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
        .map(|row| row.get("name"))
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
    // A different conversation may retain unknown historical work. It cannot
    // grant, or block, this conversation's exact retired predecessor.
    let query = format!("WITH RECURSIVE history(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM history WHERE n<16384) INSERT INTO production_runs({}) SELECT {expressions} FROM production_runs r CROSS JOIN history WHERE r.id=?5", columns.join(","));
    sqlx::query(&query)
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn root_attested_terminal_restart_is_scoped_to_its_retired_history() {
    let f = setup().await;
    let (_, check) = prepared(&f).await;
    let (prior, decision) = proposal(&f).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &decision)
        .await
        .unwrap();
    f.handle
        .retire_terminal_supervisor(&f.token, &prior.run.run_id)
        .await
        .unwrap();
    unrelated_history(&f, &prior.run.run_id).await;
    let installation = root_installation(&f, check.clone());
    let project: String =
        sqlx::query_scalar("SELECT id FROM workspace_projects WHERE conversation_id=?")
            .bind(f.conversation.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    let operations = Arc::new(AtomicUsize::new(0));
    let checks = check.physical_checks.load(Ordering::SeqCst);
    let hook_check = check.clone();
    let counted = operations.clone();
    let mut reopened = f.store.clone();
    reopened.pool = SqlitePoolOptions::new()
        .max_connections(1)
        .before_acquire(move |connection, _| {
            let check = hook_check.clone();
            let counted = counted.clone();
            Box::pin(async move {
                if check.physical_checks.load(Ordering::SeqCst) > checks {
                    connection
                        .lock_handle()
                        .await?
                        .set_progress_handler(1_000, move || {
                            counted.fetch_add(1, Ordering::SeqCst);
                            // Bounded work-rate control makes the real SQLite
                            // whole-history query expire the unchanged handoff.
                            // No clock/authority/deadline production hook exists.
                            std::thread::sleep(Duration::from_micros(100));
                            true
                        });
                }
                Ok(true)
            })
        })
        .connect_with(
            SqliteConnectOptions::new()
                .filename(f.root.join("core.sqlite3"))
                .foreign_keys(true),
        )
        .await
        .unwrap();
    let restart = || {
        config(ProductionTakeover::ExpiredPredecessor {
            incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
        })
    };
    let started = std::time::Instant::now();
    let result = reopened
        .reattach_terminal_supervisor_with_workspace(
            &f.token,
            restart(),
            &prior.run.run_id,
            project.parse().unwrap(),
            installation,
        )
        .await;
    eprintln!(
        "terminal restart result={:?} elapsed={:?} progress_callbacks={}",
        result.as_ref().err(),
        started.elapsed(),
        operations.load(Ordering::SeqCst)
    );
    let (next, metadata, grant) =
        result.expect("valid unrelated history cannot consume the physical handoff");
    assert_ne!(
        next.supervisor_incarnation(),
        f.handle.supervisor_incarnation()
    );
    assert_eq!(metadata.binding().session_id, prior.run.session_id);
    assert_eq!(grant.generation(), 1);
    assert!(
        reopened
            .reattach_terminal_supervisor_with_workspace(
                &f.token,
                restart(),
                &prior.run.run_id,
                project.parse().unwrap(),
                root_installation(&f, check),
            )
            .await
            .is_err(),
        "original predecessor must not be reissued"
    );
}
