use super::*;
use sqlx::{migrate::Migrate, sqlite::SqliteConnectOptions, Connection, SqliteConnection};

#[tokio::test]
async fn actual_store_upgrade_holds_unverifiable_old_claims_and_preserves_history() {
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("worker-task-upgrade-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let options = SqliteConnectOptions::new()
        .filename(root.join("core.sqlite3"))
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
    conn.ensure_migrations_table().await.unwrap();
    for migration in sqlx::migrate!("./migrations")
        .iter()
        .take_while(|m| m.version < 31)
    {
        conn.apply(migration).await.unwrap();
    }
    conn.close().await.unwrap();
    // Model an existing version-30 Store, then upgrade exclusively through the
    // ordinary Store::open preflight/migration path below.
    let store = Store {
        pool: sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .unwrap(),
        authority: None,
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        workspace_handles: Default::default(),
        #[cfg(feature = "fixture-test-controls")]
        production_checkpoint: None,
        deep_burst_quiet_ms: 0,
    };
    let historical_guard =
        crate::production_runtime::historical_guard_fixture::HistoricalGuardFixture::install(
            &store, 30,
        )
        .await;
    let conversation = store
        .setup("synthetic-upgrade-owner", "synthetic-password-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-upgrade-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "ab".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let handle = store
        .authorize_supervisor(
            &token,
            crate::production_runtime::tests::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    let core = Case {
        store,
        handle,
        root,
        owner,
        conversation,
        token,
    };
    let (parent, input) = running(&core).await;
    let WorkerDelegationResult::Fresh(grant) = core
        .handle
        .delegate_worker(&core.token, &parent.run.run_id, &input)
        .await
        .unwrap()
    else {
        panic!("fresh grant")
    };
    let delegation = grant.id().to_string();
    let child = core.handle.admit_worker(&core.token, grant).await.unwrap();
    for (state, claim, delegated) in [
        ("claimed", Some("cd".repeat(32)), None),
        ("queued", None, None),
        ("delegated", None, Some(delegation.clone())),
    ] {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO worker_tasks(id,owner_id,conversation_id,parent_run_id,context_id,incarnation_id,parent_control_revision,source_message_id,source_event_id,request_key,request_digest,lifetime_ms,created_at_ms,state,claim_hash,delegation_id) SELECT ?,r.owner_id,r.conversation_id,r.id,r.context_id,r.incarnation_id,c.revision,r.message_id,r.event_id,?,?,30000,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),?,?,? FROM production_runs r JOIN production_control_revisions c ON c.run_id=r.id WHERE r.id=?")
            .bind(&id).bind(format!("old-task:{state}")).bind("ef".repeat(32))
            .bind(state).bind(claim).bind(delegated).bind(parent.run.run_id.to_string())
            .execute(&core.store.pool).await.unwrap();
        sqlx::query("INSERT INTO worker_task_payloads(task_id,title,instructions) VALUES(?,'Synthetic legacy task','Synthetic legacy instructions')")
            .bind(id).execute(&core.store.pool).await.unwrap();
    }
    let before: Vec<(String, String, String, String)> = sqlx::query_as("SELECT t.id,t.request_digest,p.title,p.instructions FROM worker_tasks t JOIN worker_task_payloads p ON p.task_id=t.id ORDER BY t.ordinal")
        .fetch_all(&core.store.pool).await.unwrap();
    historical_guard.remove(&core.store).await;
    core.store.close().await;
    let upgraded = Store::open(&core.root.join("core.sqlite3")).await.unwrap();
    let rows: Vec<(String, bool, bool)> = sqlx::query_as("SELECT state,claim_hash IS NOT NULL,issuer_token_hash IS NOT NULL FROM worker_tasks ORDER BY ordinal")
        .fetch_all(&upgraded.pool).await.unwrap();
    assert_eq!(
        rows,
        vec![
            ("held".into(), false, false),
            ("held".into(), false, false),
            ("delegated".into(), false, false)
        ]
    );
    let after: Vec<(String, String, String, String)> = sqlx::query_as("SELECT t.id,t.request_digest,p.title,p.instructions FROM worker_tasks t JOIN worker_task_payloads p ON p.task_id=t.id ORDER BY t.ordinal")
        .fetch_all(&upgraded.pool).await.unwrap();
    assert_eq!(before, after);
    let linked: String = sqlx::query_scalar("SELECT d.admitted_run_id FROM worker_tasks t JOIN worker_provider_delegations d ON d.id=t.delegation_id WHERE t.state='delegated'")
        .fetch_one(&upgraded.pool).await.unwrap();
    assert_eq!(linked, child.provider.run.run_id.to_string());
    upgraded.close().await;
    let reopened = Store::open(&core.root.join("core.sqlite3")).await.unwrap();
    reopened.close().await;
    std::fs::remove_dir_all(core.root).unwrap();
}
