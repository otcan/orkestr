use super::*;
use crate::Store;
use std::collections::BTreeMap;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated test home"))
            .join(format!("preflight-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn db(&self) -> PathBuf {
        self.0.join("test.sqlite3")
    }
    fn files(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                assert!(
                    entry.file_type().unwrap().is_file(),
                    "scratch directory leaked"
                );
                (entry.file_name().into(), fs::read(entry.path()).unwrap())
            })
            .collect()
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
async fn raw(path: &Path) -> SqliteConnection {
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true),
    )
    .await
    .unwrap()
}
async fn refused_unchanged(dir: &Directory) {
    let before = dir.files();
    assert!(Store::open(&dir.db()).await.is_err());
    assert_eq!(dir.files(), before, "refusal changed database/sidecars");
}

#[tokio::test]
async fn existing_empty_foreign_and_orphan_sidecars_are_preserved() {
    for setup in [
        "",
        "CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES ('synthetic');",
    ] {
        let dir = Directory::new();
        let mut conn = raw(&dir.db()).await;
        if !setup.is_empty() {
            sqlx::raw_sql(setup).execute(&mut conn).await.unwrap();
        }
        conn.close().await.unwrap();
        refused_unchanged(&dir).await;
    }
    let dir = Directory::new();
    fs::write(dir.db(), []).unwrap();
    refused_unchanged(&dir).await;
    for suffix in ["-wal", "-shm", "-journal"] {
        let dir = Directory::new();
        fs::write(sidecar(&dir.db(), suffix), b"synthetic orphan").unwrap();
        refused_unchanged(&dir).await;
    }
}

#[tokio::test]
async fn future_changed_checksum_and_altered_schema_are_preserved() {
    for sql in [
        "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES (999,'future',1,X'00',0)",
        "UPDATE _sqlx_migrations SET checksum=X'00' WHERE version=1",
        "ALTER TABLE messages ADD COLUMN unexpected TEXT",
        "CREATE TRIGGER unexpected AFTER INSERT ON owners BEGIN SELECT 1; END",
    ] {
        let dir = Directory::new();
        let store = Store::open(&dir.db()).await.unwrap();
        store.close().await;
        let mut conn = raw(&dir.db()).await;
        sqlx::raw_sql(sql).execute(&mut conn).await.unwrap();
        conn.close().await.unwrap();
        refused_unchanged(&dir).await;
    }
}

#[tokio::test]
async fn future_migration_only_in_live_wal_is_refused_without_source_writes() {
    let dir = Directory::new();
    let store = Store::open(&dir.db()).await.unwrap();
    store.close().await;
    let main_before = fs::read(dir.db()).unwrap();
    let mut conn = raw(&dir.db()).await;
    sqlx::query("PRAGMA wal_autocheckpoint=0")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES (999,'future',1,X'00',0)")
        .execute(&mut conn).await.unwrap();
    assert_eq!(
        fs::read(dir.db()).unwrap(),
        main_before,
        "future version must remain WAL-only"
    );
    assert!(fs::metadata(sidecar(&dir.db(), "-wal")).unwrap().len() > 32);
    refused_unchanged(&dir).await;
    conn.close().await.unwrap();
}

#[tokio::test]
async fn foreign_live_wal_is_refused_without_source_writes() {
    let dir = Directory::new();
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(dir.db())
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_autocheckpoint=0")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES ('synthetic');",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    refused_unchanged(&dir).await;
    conn.close().await.unwrap();
}

#[tokio::test]
async fn supported_earlier_migration_prefix_is_identified_then_upgraded() {
    let dir = Directory::new();
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(dir.db())
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
    )
    .await
    .unwrap();
    conn.ensure_migrations_table().await.unwrap();
    let migrator = sqlx::migrate!("./migrations");
    let first = migrator.iter().next().unwrap();
    sqlx::raw_sql(&first.sql).execute(&mut conn).await.unwrap();
    sqlx::query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES (?,?,1,?,0)")
        .bind(first.version).bind(first.description.as_ref()).bind(first.checksum.as_ref())
        .execute(&mut conn).await.unwrap();
    conn.close().await.unwrap();
    let store = Store::open(&dir.db()).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count as usize, migrator.iter().count());
    store.close().await;
    let reopened = Store::open(&dir.db()).await.unwrap();
    reopened.close().await;
}

async fn populated_dispatch_prefix(dir: &Directory) -> SqliteConnection {
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(dir.db())
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
    )
    .await
    .unwrap();
    conn.ensure_migrations_table().await.unwrap();
    let migrator = sqlx::migrate!("./migrations");
    for migration in migrator.iter().take(4) {
        conn.apply(migration).await.unwrap();
    }
    sqlx::raw_sql("INSERT INTO owners(id,username,password_hash) VALUES('owner','synthetic','synthetic');
    INSERT INTO conversations(id,owner_id,sequence) VALUES('conversation','owner',1);
    INSERT INTO messages VALUES('message','owner','conversation','input','digest','synthetic','owner',1);
    INSERT INTO events(id,owner_id,conversation_id,message_id,sequence) VALUES('event','owner','conversation','message',1);
    INSERT INTO outbox(event_id) VALUES('event');
    INSERT INTO fixture_supervisors VALUES('context','owner','synthetic','key','incarnation',1,9999999999999);
    INSERT INTO session_bindings(id,owner_id,conversation_id,role,provider_kind,provider_namespace,native_session_id,state) VALUES('session','owner','conversation','deep','explicit_fixture','synthetic','synthetic-native','busy');
    INSERT INTO fixture_readiness VALUES('session','context','incarnation',1);
    INSERT INTO fixture_runs VALUES('run','context','incarnation','owner','conversation','session','synthetic-native',1,'message','event',1,1,'run-key','digest',1,1,9999999999999,1,'starting','delivery_unknown',NULL,NULL,NULL);
    INSERT INTO reasoning_inbox(conversation_id,sequence,message_id,event_id,state,claimant_session_id,claim_generation,claim_deadline_ms,admitted_fixture_run_id) VALUES('conversation',1,'message','event','consumed','session',1,9999999999999,'run');").execute(&mut conn).await.unwrap();
    conn
}

#[tokio::test]
async fn populated_dispatch_prefix_upgrade_preserves_inbound_links_and_checksums() {
    let dir = Directory::new();
    let mut conn = populated_dispatch_prefix(&dir).await;
    let legacy: (String, String, i64, String) =
        sqlx::query_as("SELECT id,message_id,sequence,occurred_at FROM events")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    let checksums: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut conn)
            .await
            .unwrap();
    conn.close().await.unwrap();
    let store = Store::open(&dir.db()).await.unwrap();
    let after: (String, String, i64, String) =
        sqlx::query_as("SELECT id,message_id,sequence,occurred_at FROM events")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(legacy, after);
    let after_checksums: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT checksum FROM _sqlx_migrations WHERE version<=4 ORDER BY version",
    )
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(checksums, after_checksums);
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&store.pool)
        .await
        .unwrap()
        .is_empty());
    let links: i64 = sqlx::query_scalar("SELECT count(*) FROM reasoning_inbox i JOIN fixture_runs r ON r.id=i.admitted_fixture_run_id JOIN events e ON e.id=r.event_id JOIN outbox o ON o.event_id=e.id WHERE i.event_id=e.id AND r.message_id=e.message_id").fetch_one(&store.pool).await.unwrap();
    assert_eq!(links, 1);
    let issued: (String, i64, i64) =
        sqlx::query_as("SELECT run_id,generation,lease_deadline_ms FROM fixture_run_leases")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(issued, ("run".into(), 1, 9999999999999));
    store.close().await;
    Store::open(&dir.db()).await.unwrap().close().await;
}

#[tokio::test]
async fn data_constraint_upgrade_failure_in_live_wal_preserves_source_and_sidecars() {
    let dir = Directory::new();
    let mut conn = populated_dispatch_prefix(&dir).await;
    sqlx::raw_sql("PRAGMA wal_autocheckpoint=0;
    INSERT INTO fixture_runs SELECT 'run-two',context_id,incarnation_id,owner_id,conversation_id,session_id,native_session_id,binding_generation,message_id,event_id,scope_sequence+1,claim_generation,'run-key-two',input_digest,lease_generation,dispatch_fence,lease_deadline_ms,attempt,'blocked','quarantined',NULL,NULL,NULL FROM fixture_runs;").execute(&mut conn).await.unwrap();
    // Valid prefix 4 permits historical reuse; selected no-reuse migration cannot
    // silently discard this conflicting history. Its copy rehearsal must refuse.
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut conn)
        .await
        .unwrap()
        .is_empty());
    refused_unchanged(&dir).await;
    conn.close().await.unwrap();
}

#[tokio::test]
async fn populated_observation_prefix_upgrade_preserves_rows_and_issued_history() {
    let dir = Directory::new();
    let mut conn = populated_dispatch_prefix(&dir).await;
    for migration in sqlx::migrate!("./migrations").iter().skip(4).take(2) {
        conn.apply(migration).await.unwrap();
    }
    sqlx::raw_sql("INSERT INTO events(id,owner_id,conversation_id,sequence,kind,schema_version) VALUES('observed','owner','conversation',2,'fixture_provider_observed',2);
    INSERT INTO outbox(event_id) VALUES('observed');
    INSERT INTO fixture_observations VALUES('observed','run',1,'digest','started',NULL,1,1,'running');
    UPDATE fixture_runs SET state='running'; UPDATE conversations SET sequence=2;
    INSERT INTO fixture_run_leases VALUES('run',2,9999999999999);").execute(&mut conn).await.unwrap();
    let checksums: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut conn)
            .await
            .unwrap();
    let before: Vec<(String, String, i64, String)> =
        sqlx::query_as("SELECT id,kind,sequence,occurred_at FROM events ORDER BY sequence")
            .fetch_all(&mut conn)
            .await
            .unwrap();
    conn.close().await.unwrap();
    let store = Store::open(&dir.db()).await.unwrap();
    let after: Vec<(String, String, i64, String)> =
        sqlx::query_as("SELECT id,kind,sequence,occurred_at FROM events ORDER BY sequence")
            .fetch_all(&store.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    let after_checksums: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT checksum FROM _sqlx_migrations WHERE version<=6 ORDER BY version",
    )
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(checksums, after_checksums);
    let issued: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT generation,purpose,dispatch_fence FROM fixture_run_leases ORDER BY generation",
    )
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(
        issued,
        vec![(1, "execution".into(), 1), (2, "execution".into(), 1)]
    );
    let links: i64 = sqlx::query_scalar("SELECT count(*) FROM fixture_observations o JOIN events e ON e.id=o.event_id JOIN outbox b ON b.event_id=e.id JOIN fixture_runs r ON r.id=o.run_id JOIN reasoning_inbox i ON i.admitted_fixture_run_id=r.id WHERE o.kind='started' AND o.receipt_state='running' AND r.state='running' AND i.state='consumed'").fetch_one(&store.pool).await.unwrap();
    assert_eq!(links, 1);
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&store.pool)
        .await
        .unwrap()
        .is_empty());
    store.close().await;
    Store::open(&dir.db()).await.unwrap().close().await;
}

#[tokio::test]
async fn populated_payload_prefix_upgrade_preserves_all_rows_and_foreign_links() {
    let dir = Directory::new();
    let mut conn = populated_payload_prefix(&dir).await;
    async fn rows(conn: &mut SqliteConnection) -> BTreeMap<String, Vec<String>> {
        let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('production_acceptances','history_imports','history_messages','worker_tool_delegations','worker_provider_delegations','history_recovery_restores','history_recovery_children','production_resume_metadata','production_control_revisions','production_stop_boundaries','production_held_inputs','worker_tasks','worker_task_payloads','dormant_timers','dormant_timer_controls','dormant_timer_claims','production_graceful_retirements','attachment_manifests','attachment_objects','attachment_imports','attachment_removals','automatic_reply_routes','automatic_reply_permissions','automatic_reply_inputs','automatic_reply_sends','production_stopped_retirements','dormant_timer_input_guards','dormant_timer_inputs','production_requested_native','worker_tool_results','durable_timer_authorities','production_steering','production_steering_turns','worker_running_budgets','workspace_projects','workspace_session_projects','workspace_launches','memory_settings','memory_records','memory_decisions','execution_windows','execution_window_inputs','workspace_exec_profiles','workspace_exec_delegations','workspace_exec_results','archived_history_sources','archived_history_messages','archived_history_quarantine','execution_window_queue','execution_window_reconciliations','production_run_abandonments','execution_window_released_inputs','production_abandoned_retirements','dormant_timer_targets','conversation_settings','desktop_bindings','desktop_leases','legacy_worker_links','legacy_worker_transitions','production_failure_classes','execution_window_open_failures','execution_window_open_failure_inputs','execution_window_failed_resume_metadata','production_run_failures','production_run_lapses','production_lapsed_retirements','worker_task_failures','production_abandonment_causes','production_run_lost_failures','sidebar_read_marks','conversation_lineage','whatsapp_chat_provisions','production_auto_acceptances','timer_policies','conversation_timer_pauses','timer_outcomes','timer_digests','timer_trigger_events','message_reply_to','restricted_threads','restricted_messages','restricted_audit','restricted_approvals','restricted_grants','attachment_recipients','attachment_encryption_policies','attachment_sealed_objects','conversation_posts','sidebar_hidden_entries','conversation_native_resets','execution_window_failed_native_requests','owner_input_retirements','production_run_models') ORDER BY name")
            .fetch_all(&mut *conn).await.unwrap();
        let mut result = BTreeMap::new();
        for table in tables {
            let columns: Vec<String> = sqlx::query_scalar(&format!(
                "SELECT name FROM pragma_table_info('{table}') ORDER BY cid"
            ))
            .fetch_all(&mut *conn)
            .await
            .unwrap();
            let columns: Vec<_> = columns
                .into_iter()
                .filter(|column| {
                    (table != "production_runs"
                        || !["role", "parent_session_id", "worker_delegation_id"]
                            .contains(&column.as_str()))
                        && (table != "production_cancellations"
                            || column != "request_control_revision")
                })
                .collect();
            let expression = columns
                .iter()
                .map(|c| format!("quote(\"{c}\")"))
                .collect::<Vec<_>>()
                .join(" || '|' || ");
            let filter = if table == "_sqlx_migrations" {
                " WHERE version<=14"
            } else {
                ""
            };
            let data = sqlx::query_scalar(&format!(
                "SELECT {expression} AS row FROM \"{table}\"{filter} ORDER BY row"
            ))
            .fetch_all(&mut *conn)
            .await
            .unwrap();
            result.insert(table, data);
        }
        result
    }
    let mut expected = rows(&mut conn).await;
    // Migration 43 appends the legacy standalone default and derives a titled
    // directory entry without replacing any conversation or existing row.
    for row in expected.get_mut("conversations").unwrap() {
        row.push_str("|0");
    }
    // Migration 80 places every existing role record in Fast slot 0.
    for row in expected.get_mut("session_bindings").unwrap() {
        row.push_str("|0");
    }
    expected.insert(
        "conversation_directory".into(),
        vec![
            "1|'conversation'|'owner'|'Assistant'|NULL|NULL".into(),
            "2|'production-conversation'|'owner'|'Synthetic'|NULL|NULL".into(),
        ],
    );
    // New optional preferences, tracker and continuity tables remain empty.
    for table in [
        "agent_timer_grants",
        "agent_timers",
        "agent_timer_audit",
        "thread_ask_grants",
        "thread_asks",
        "message_authors",
        "thread_ask_audit",
        "production_fast_continuity",
        "production_fast_digests",
        "conversation_provider_handoffs",
        "conversation_handoff_sessions",
        "conversation_handoff_context_delivery",
        "trackers",
        "tracker_rows",
        "tracker_row_links",
        "conversation_fast_settings",
        "tracker_events",
        "tracker_ledger",
        "tracker_batches",
        "tracker_messages",
        "tracker_row_merges",
        "tracker_unresolved_events",
        "tracker_intake_audit",
        "tracker_source_selections",
        "tracker_scan_authorities",
        "tracker_scan_attempts",
        "tracker_scan_receipts",
        "tracker_discovery_receipts",
        "tracker_automation_decisions",
        "tracker_automation_settings",
        "tracker_local_sources",
        "tracker_check_cancellations",
        "tracker_manual_checks",
        "tracker_action_digests",
    ] {
        expected.insert(table.into(), Vec::new());
    }
    conn.close().await.unwrap();
    let store = Store::open(&dir.db()).await.unwrap();
    let mut conn = raw(&dir.db()).await;
    assert_eq!(rows(&mut conn).await, expected);
    for table in [
        "owner_input_retirements",
        "conversation_native_resets",
        "execution_window_failed_native_requests",
        "execution_window_open_failures",
        "execution_window_open_failure_inputs",
        "execution_window_failed_resume_metadata",
        "production_run_failures",
        "production_run_lapses",
        "production_lapsed_retirements",
        "worker_task_failures",
        "production_abandonment_causes",
        "production_run_lost_failures",
        "dormant_timer_targets",
        "conversation_fast_settings",
        "conversation_settings",
        "desktop_bindings",
        "desktop_leases",
        "legacy_worker_links",
        "legacy_worker_transitions",
        "execution_window_queue",
        "production_failure_classes",
        "archived_history_sources",
        "archived_history_messages",
        "archived_history_quarantine",
        "workspace_exec_profiles",
        "workspace_exec_delegations",
        "workspace_exec_results",
        "execution_window_reconciliations",
        "production_run_abandonments",
        "execution_window_released_inputs",
        "production_abandoned_retirements",
        "production_stop_boundaries",
        "production_held_inputs",
        "worker_tasks",
        "worker_task_payloads",
        "dormant_timers",
        "dormant_timer_controls",
        "dormant_timer_claims",
        "production_graceful_retirements",
        "production_stopped_retirements",
        "attachment_manifests",
        "attachment_objects",
        "attachment_imports",
        "attachment_removals",
        "workspace_projects",
        "workspace_session_projects",
        "workspace_launches",
        "execution_windows",
        "execution_window_inputs",
        "memory_settings",
        "memory_records",
        "memory_decisions",
        "automatic_reply_routes",
        "automatic_reply_permissions",
        "automatic_reply_inputs",
        "automatic_reply_sends",
        "dormant_timer_input_guards",
        "dormant_timer_inputs",
        "production_requested_native",
        "worker_tool_results",
        "durable_timer_authorities",
        "production_steering",
        "production_steering_turns",
        "worker_running_budgets",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
    }
    let legacy:(String,Option<String>,Option<String>)=sqlx::query_as("SELECT role,parent_session_id,worker_delegation_id FROM production_runs WHERE id='production-run'").fetch_one(&mut conn).await.unwrap();
    assert_eq!(legacy, ("deep".into(), None, None));
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut conn)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM production_acceptances")
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT max(version) FROM _sqlx_migrations")
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        81
    );
    for table in [
        "history_imports",
        "history_messages",
        "worker_tool_delegations",
        "worker_provider_delegations",
        "history_recovery_restores",
        "history_recovery_children",
        "production_resume_metadata",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
    }
    conn.close().await.unwrap();
    store.close().await;
    Store::open(&dir.db()).await.unwrap().close().await;
}

async fn populated_payload_prefix(dir: &Directory) -> SqliteConnection {
    let mut conn = populated_dispatch_prefix(dir).await;
    for migration in sqlx::migrate!("./migrations").iter().skip(4).take(10) {
        conn.apply(migration).await.unwrap();
    }
    sqlx::raw_sql("INSERT INTO projects(id,owner_id,request_key,payload_digest,name) VALUES('production-project','owner','project-key','digest','Synthetic');
    INSERT INTO conversations(id,owner_id,project_id,sequence) VALUES('production-conversation','owner','production-project',3);
    INSERT INTO messages VALUES('production-message','owner','production-conversation','production-input','digest','synthetic','owner',1);
    INSERT INTO events(id,owner_id,conversation_id,message_id,sequence) VALUES('production-input-event','owner','production-conversation','production-message',1);
    INSERT INTO session_bindings(id,owner_id,conversation_id,role,provider_kind,provider_namespace,native_session_id,state) VALUES('production-session','owner','production-conversation','deep','codex','synthetic','production-native','busy');
    INSERT INTO production_supervisors VALUES('production-context','owner','codex','synthetic','key','production-incarnation',1,9999999999999);
    INSERT INTO production_readiness VALUES('production-session','production-context','production-incarnation','synthetic-v1','ready','digest');
    INSERT INTO production_runs VALUES('production-run','production-context','production-incarnation','owner','production-conversation','production-session','production-native','codex',1,'production-message','production-input-event',1,1,'production-key','digest',1,1,9999999999999,1,'awaiting_acceptance','delivery_unknown',NULL,NULL,NULL);
    INSERT INTO production_run_leases VALUES('production-run',1,9999999999999,1,'execution');
    INSERT INTO reasoning_inbox(conversation_id,sequence,message_id,event_id,state,claimant_session_id,claim_generation,claim_deadline_ms,admitted_run_id) VALUES('production-conversation',1,'production-message','production-input-event','consumed','production-session',1,9999999999999,'production-run');
    INSERT INTO events(id,owner_id,conversation_id,sequence,kind,schema_version) VALUES('progress','owner','production-conversation',2,'provider_observed',8),('completion','owner','production-conversation',3,'provider_observed',5);
    INSERT INTO outbox(event_id) VALUES('production-input-event'),('progress'),('completion');
    INSERT INTO production_observations VALUES('progress','production-run',1,'progress-digest','progress',1,1,'running'),('completion','production-run',2,'completion-digest','completed_proposal',1,1,'awaiting_acceptance');
    INSERT INTO production_payloads VALUES('payload','progress','owner','production-conversation','production-run','synthetic progress');").execute(&mut conn).await.unwrap();
    conn
}

mod schema36_edges;

async fn assert_parallel_fast_schema(pool: &sqlx::SqlitePool) {
    let index: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_schema WHERE type='index' AND name='canonical_role'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert!(index.contains("(owner_id, conversation_id, role, fast_slot)"));
    let unslotted: i64 =
        sqlx::query_scalar("SELECT count(*) FROM session_bindings WHERE fast_slot!=0")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(unslotted, 0, "every existing record becomes slot 0");
    let duplicated: i64 = sqlx::query_scalar("SELECT count(*) FROM (SELECT 1 FROM session_bindings WHERE role IN ('fast','deep') AND state!='retired' GROUP BY owner_id,conversation_id,role HAVING count(*)>1)")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(duplicated, 0);
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await
        .unwrap()
        .is_empty());
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
}

#[tokio::test]
async fn schema_77_fast_lineage_upgrades_into_slot_zero_with_bounded_slots() {
    let dir = Directory::new();
    let mut conn = populated_dispatch_prefix(&dir).await;
    let migrator = sqlx::migrate!("./migrations");
    for migration in migrator.iter().skip(4).filter(|m| m.version <= 77) {
        conn.apply(migration).await.unwrap();
    }
    // A schema-77 conversation: retired Fast history, one live Fast lineage,
    // the live Deep record from the dispatch prefix.
    sqlx::raw_sql("INSERT INTO session_bindings(id,owner_id,conversation_id,role,provider_kind,provider_namespace,native_session_id,state) VALUES('old-fast','owner','conversation','fast','codex','synthetic','old-fast-native','retired');
    INSERT INTO session_bindings(id,owner_id,conversation_id,role,provider_kind,provider_namespace,native_session_id,state) VALUES('live-fast','owner','conversation','fast','codex','synthetic','live-fast-native','lost');")
        .execute(&mut conn).await.unwrap();
    let before: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id,role,state FROM session_bindings ORDER BY id")
            .fetch_all(&mut conn)
            .await
            .unwrap();
    conn.close().await.unwrap();
    let store = Store::open(&dir.db()).await.unwrap();
    let after: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id,role,state FROM session_bindings ORDER BY id")
            .fetch_all(&store.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    assert_parallel_fast_schema(&store.pool).await;
    let insert = |slot: i64| {
        sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role,fast_slot) VALUES(?,'owner','conversation','fast',?)")
            .bind(Uuid::new_v4().to_string())
            .bind(slot)
    };
    // The live lineage stays the only slot-0 Fast; slots 1-7 only.
    assert!(insert(0).execute(&store.pool).await.is_err());
    for slot in 1..=7 {
        insert(slot).execute(&store.pool).await.unwrap();
    }
    assert!(insert(8).execute(&store.pool).await.is_err());
    assert!(insert(7).execute(&store.pool).await.is_err());
    store.close().await;
    Store::open(&dir.db()).await.unwrap().close().await;
}

/// Manual rehearsal on a private COPY of a real schema 77-79 store:
/// `ORKESTR_SCHEMA77_COPY=/path/copy.sqlite3 cargo test -- --ignored`. The
/// copy is upgraded in place; never point this at a live database.
#[tokio::test]
#[ignore]
async fn real_schema_77_copy_upgrades() {
    let Some(copy) = std::env::var_os("ORKESTR_SCHEMA77_COPY") else {
        return;
    };
    let copy = PathBuf::from(copy);
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&copy)
            .create_if_missing(false),
    )
    .await
    .unwrap();
    let version: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    // Any pre-slot schema the live train can hold: 77 (pre-#341) to 79.
    assert!(
        (77..=79).contains(&version),
        "rehearsal needs a schema 77-79 copy, got {version}"
    );
    let before: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id,role,state FROM session_bindings ORDER BY id")
            .fetch_all(&mut conn)
            .await
            .unwrap();
    conn.close().await.unwrap();
    let store = Store::open(&copy).await.unwrap();
    let after: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id,role,state FROM session_bindings ORDER BY id")
            .fetch_all(&store.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    assert_parallel_fast_schema(&store.pool).await;
    println!("rehearsed {} session records", after.len());
    store.close().await;
}
