//! Historical test producers must never erase real tracker evidence.
use crate::Store;

pub(crate) async fn downgrade_empty(store: &Store) {
    crate::history_import::timers::scan_action::migration_fixture::downgrade_empty(store).await;
    let tables = [
        "tracker_intake_audit",
        "tracker_unresolved_events",
        "tracker_row_merges",
        "tracker_messages",
        "tracker_row_links",
        "tracker_events",
        "tracker_rows",
        "tracker_batches",
        "tracker_ledger",
        "trackers",
    ];
    let mut tx = store.pool.begin().await.unwrap();
    for table in tables {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "historical fixtures must not erase tracker data: {table}"
        );
    }
    for table in tables {
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=74")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}
