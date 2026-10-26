//! Upgrade preserves prior uncertainty instead of reviving blocked execution.
use super::*;
use crate::production_runtime::{observation_tests::input as event, tests::setup};

#[tokio::test]
async fn proposal_migration_preserves_old_blocked_children_and_every_prior_row() {
    let f = setup().await;
    let (parent, worker, _) = super::completed_tests::completed_worker(&f).await;
    let old = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/0022_fast_provider_runs.sql"
    ));
    let trigger = old
        .split("CREATE TRIGGER worker_provider_parent_fence")
        .nth(1)
        .unwrap()
        .split("CREATE TEMP TABLE")
        .next()
        .unwrap();
    crate::production_runtime::tests::downgrade_window_deadlines(&f.store).await;
    let mut tx = f.store.pool.begin().await.unwrap();
    sqlx::query("DROP TRIGGER worker_provider_parent_fence")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER worker_provider_parent_fence{trigger}"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    // Model the actual schema-43 source, including absence of later opt-in
    // tables. Removing only a checksum row would create a foreign schema.
    // Undo 0052 and 0048 first: their views replaced the 0037 evidence views.
    for statement in [
        "DROP VIEW production_retirement_provenance",
        "DROP VIEW production_terminal_evidence",
        "DROP TABLE production_run_lost_failures",
        "DROP TABLE production_abandonment_causes",
        "DROP TABLE worker_task_failures",
        "DROP TABLE production_lapsed_retirements",
        "DROP TABLE production_run_lapses",
        "DROP TABLE production_run_failures",
        "DROP TABLE execution_window_failed_resume_metadata",
        "DROP TABLE execution_window_open_failure_inputs",
        "DROP TABLE execution_window_open_failures",
        "DROP TABLE production_abandoned_retirements",
        "DROP TABLE execution_window_released_inputs",
        "DROP TABLE production_run_abandonments",
        "DROP TABLE execution_window_reconciliations",
    ] {
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
    }
    let views = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/0037_stopped_retirement.sql"
    ));
    let views = &views[views
        .find("CREATE VIEW production_terminal_evidence")
        .unwrap()..];
    sqlx::raw_sql(views).execute(&mut *tx).await.unwrap();
    for table in [
        "dormant_timer_targets",
        "legacy_worker_transitions",
        "legacy_worker_links",
        "desktop_leases",
        "desktop_bindings",
        "conversation_settings",
        "execution_window_queue",
        "production_failure_classes",
        "archived_history_messages",
        "archived_history_quarantine",
        "archived_history_sources",
        "workspace_exec_results",
        "workspace_exec_delegations",
        "workspace_exec_profiles",
    ] {
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version>=44")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    f.handle
        .append_provider_event(
            &f.owner,
            &parent,
            &event(
                &parent,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        super::completed_tests::state(&f, &worker).await,
        ("blocked".into(), "lost".into(), "blocked".into())
    );
    let before = super::tests::ledger(&f.store).await;
    f.store.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    assert_eq!(super::tests::ledger(&reopened).await, before);
    let latest: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
    assert_eq!(latest, 79);
}
