//! Upgrades from older schemas with windows stranded by older releases.
use super::*;

fn between<'a>(sql: &'a str, start: &str, end: Option<&str>) -> &'a str {
    let from = sql.find(start).unwrap();
    match end {
        Some(end) => &sql[from..sql.find(end).unwrap()],
        None => &sql[from..],
    }
}

/// Undo 0061, 0060, 0059, 0058, 0057, 0056 and 0055 exactly: the schema-54 lapse CHECKs and evidence view.
pub(super) async fn downgrade_to_schema54(store: &Store) {
    let v54 = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/0054_lapsed_runs.sql"
    ));
    let lapses = between(
        v54,
        "CREATE TABLE production_run_lapses (",
        Some("CREATE TABLE production_lapsed_retirements"),
    );
    crate::production_runtime::tests::downgrade_window_deadlines(store).await;
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await
        .unwrap();
    for statement in [
        "DROP VIEW production_terminal_evidence",
        "DROP TABLE production_abandonment_causes",
        "DELETE FROM _sqlx_migrations WHERE version=55",
        "CREATE TEMP TABLE lapses_copy AS SELECT * FROM production_run_lapses",
        "DROP TABLE production_run_lapses",
    ] {
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
    }
    sqlx::raw_sql(lapses).execute(&mut *tx).await.unwrap();
    for statement in [
        "INSERT INTO production_run_lapses SELECT * FROM lapses_copy",
        "DROP TABLE lapses_copy",
    ] {
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
    }
    sqlx::raw_sql(between(
        v54,
        "CREATE VIEW production_terminal_evidence",
        Some("DROP VIEW production_retirement_provenance"),
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

/// Undo 0054 exactly: the schema-53 views, outcome CHECK and no lapse tables.
pub(super) async fn downgrade_to_schema53(store: &Store) {
    downgrade_to_schema54(store).await;
    let v48 = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/0048_stranded_window_reconciliation.sql"
    ));
    let v53 = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/0053_stranded_lost_worker.sql"
    ));
    let table = between(
        v48,
        "CREATE TABLE execution_window_reconciliations",
        Some("-- An unaccepted completed proposal"),
    );
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await
        .unwrap();
    for statement in [
        "DROP VIEW production_terminal_evidence",
        "DROP VIEW production_retirement_provenance",
        "DROP TABLE worker_task_failures",
        "DROP TABLE production_lapsed_retirements",
        "DROP TABLE production_run_lapses",
        "DELETE FROM _sqlx_migrations WHERE version=54",
    ] {
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
    }
    // Recreate under the original, unquoted 0048 definition.
    for statement in [
        "CREATE TEMP TABLE reconciliations_copy AS SELECT * FROM execution_window_reconciliations",
        "DROP TABLE execution_window_reconciliations",
    ] {
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
    }
    sqlx::raw_sql(table).execute(&mut *tx).await.unwrap();
    for statement in [
        "INSERT INTO execution_window_reconciliations SELECT * FROM reconciliations_copy",
        "DROP TABLE reconciliations_copy",
    ] {
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
    }
    sqlx::raw_sql(between(
        v53,
        "CREATE VIEW production_terminal_evidence",
        None,
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::raw_sql(between(
        v48,
        "CREATE VIEW production_retirement_provenance",
        None,
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

/// Return a populated database to the exact schema-51 shape (before 0052).
async fn downgrade_to_schema51(store: &Store) {
    downgrade_to_schema53(store).await;
    let mut tx = store.pool.begin().await.unwrap();
    for statement in [
        "DROP VIEW production_terminal_evidence",
        "DROP TABLE production_run_lost_failures",
        "DELETE FROM _sqlx_migrations WHERE version=53",
        "DROP TABLE production_run_failures",
        "DROP TABLE execution_window_failed_resume_metadata",
        "DROP TABLE execution_window_open_failure_inputs",
        "DROP TABLE execution_window_open_failures",
        "DELETE FROM _sqlx_migrations WHERE version=52",
    ] {
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
    }
    let view = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/0048_stranded_window_reconciliation.sql"
    ));
    let start = view
        .find("CREATE VIEW production_terminal_evidence")
        .unwrap();
    let end = view
        .find("DROP VIEW production_retirement_provenance")
        .unwrap();
    sqlx::raw_sql(&view[start..end])
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

/// A Workbench left stranded by a schema-51 release: the deadline-cancelled
/// Worker blocked reconciliation. Upgrading alone changes no row; the first
/// reconciliation afterwards fails the Worker and closes the window.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schema51_stranded_workbench_reconciles_after_upgrade() {
    let b = workbench().await;
    let w = &b.p.w;
    expire_worker_lease(&w.f.store, &b.worker).await;
    downgrade_to_schema51(&w.f.store).await;
    // The schema-51 release could not plan it.
    assert!(matches!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM production_terminal_evidence WHERE run_id=?"
        )
        .bind(b.worker.run.run_id.to_string())
        .fetch_one(&w.f.store.pool)
        .await,
        Ok(0)
    ));
    let before = fixtures::snapshot(&w.f.store).await;
    let fresh = restart(w, true).await;
    assert_eq!(
        count(&fresh, "SELECT max(version) FROM _sqlx_migrations").await,
        79
    );
    for table in [
        "production_run_failures",
        "execution_window_open_failures",
        "execution_window_open_failure_inputs",
        "execution_window_failed_resume_metadata",
    ] {
        assert_eq!(
            count(&fresh, &format!("SELECT count(*) FROM {table}")).await,
            0,
            "no retroactive decision: {table}"
        );
    }
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM production_terminal_evidence WHERE terminal_kind='failed'"
        )
        .await,
        0
    );
    let after = fixtures::snapshot(&fresh).await;
    assert_eq!(before, after, "upgrading alone changes no row");
    let receipt = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(receipt.failed_run_ids, vec![b.worker.run.run_id.clone()]);
    assert_eq!(window_state(&fresh, w.status.window_id).await, "closed");
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&fresh.pool)
        .await
        .unwrap()
        .is_empty());
}
