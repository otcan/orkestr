use super::*;

async fn capture(conn: &mut SqliteConnection) -> BTreeMap<String, (Vec<String>, Vec<String>)> {
    let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .fetch_all(&mut *conn).await.unwrap();
    let mut result = BTreeMap::new();
    for table in tables {
        let columns: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT name FROM pragma_table_info('{table}') ORDER BY cid"
        ))
        .fetch_all(&mut *conn)
        .await
        .unwrap();
        let rows = selected(conn, &table, &columns, None).await;
        result.insert(table, (columns, rows));
    }
    result
}
async fn selected(
    conn: &mut SqliteConnection,
    table: &str,
    columns: &[String],
    prefix: Option<i64>,
) -> Vec<String> {
    let expression = columns
        .iter()
        .map(|c| format!("quote(\"{c}\")"))
        .collect::<Vec<_>>()
        .join(" || '|' || ");
    let filter = if table == "_sqlx_migrations" {
        format!(" WHERE version<={}", prefix.unwrap_or(50))
    } else {
        String::new()
    };
    sqlx::query_scalar(&format!(
        "SELECT {expression} AS row FROM \"{table}\"{filter} ORDER BY row"
    ))
    .fetch_all(conn)
    .await
    .unwrap()
}

#[tokio::test]
async fn populated_prefixes_copy_first_edges_to_50_preserve_rows_and_rollback_source() {
    for prefix in [
        14, 17, 31, 33, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
    ] {
        let dir = Directory::new();
        let mut conn = populated_payload_prefix(&dir).await;
        for migration in sqlx::migrate!("./migrations")
            .iter()
            .filter(|m| m.version > 14 && m.version <= prefix)
        {
            conn.apply(migration).await.unwrap();
        }
        let before = capture(&mut conn).await;
        conn.close().await.unwrap();
        let original = fs::read(dir.db()).unwrap();
        let rollback = dir.0.join("untouched-backup.sqlite3");
        fs::copy(dir.db(), &rollback).unwrap();
        let candidate = dir.0.join("candidate.sqlite3");
        fs::copy(dir.db(), &candidate).unwrap();
        let store = Store::open(&candidate).await.unwrap();
        let mut upgraded = raw(&candidate).await;
        for (table, (columns, rows)) in &before {
            assert_eq!(
                selected(&mut upgraded, table, columns, Some(prefix)).await,
                *rows,
                "prefix {prefix}, table {table}"
            );
        }
        let directory: Vec<String> = sqlx::query_scalar("SELECT quote(d.row_sequence)||'|'||quote(d.conversation_id)||'|'||quote(d.owner_id)||'|'||quote(d.name)||'|'||quote(d.request_key)||'|'||quote(d.payload_digest)||'|'||quote(c.standalone) FROM conversation_directory d JOIN conversations c ON c.id=d.conversation_id AND c.owner_id=d.owner_id ORDER BY d.row_sequence")
            .fetch_all(&mut upgraded).await.unwrap();
        assert_eq!(
            directory,
            vec![
                "1|'conversation'|'owner'|'Assistant'|NULL|NULL|0",
                "2|'production-conversation'|'owner'|'Synthetic'|NULL|NULL|0",
            ],
            "derived directory and legacy scope: {prefix}"
        );
        for table in [
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
            "execution_window_queue",
            "production_failure_classes",
            "workspace_exec_profiles",
            "workspace_exec_delegations",
            "workspace_exec_results",
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
            "worker_tool_results",
            "durable_timer_authorities",
            "production_steering",
            "production_steering_turns",
            "worker_running_budgets",
            "archived_history_sources",
            "archived_history_messages",
            "archived_history_quarantine",
            "execution_window_reconciliations",
            "production_run_abandonments",
            "execution_window_released_inputs",
            "production_abandoned_retirements",
            "conversation_settings",
            "desktop_bindings",
            "desktop_leases",
            "legacy_worker_links",
            "legacy_worker_transitions",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&mut upgraded)
                .await
                .unwrap();
            assert_eq!(count, 0, "no retroactive authority: {prefix}/{table}");
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT max(version) FROM _sqlx_migrations")
                .fetch_one(&mut upgraded)
                .await
                .unwrap(),
            71
        );
        assert!(sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut upgraded)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
                .fetch_one(&mut upgraded)
                .await
                .unwrap(),
            "ok"
        );
        upgraded.close().await.unwrap();
        store.close().await;
        Store::open(&candidate).await.unwrap().close().await;
        assert_eq!(fs::read(dir.db()).unwrap(), original);
        assert_eq!(fs::read(rollback).unwrap(), original);
    }
}
