//! Historical fixtures may remove only empty scan-action data.
use crate::Store;

pub(crate) async fn downgrade_empty(store: &Store) {
    let mut tx = store.pool.begin().await.unwrap();
    let tables = [
        "tracker_action_digests",
        "tracker_scan_receipts",
        "tracker_scan_attempts",
        "tracker_scan_authorities",
        "tracker_source_selections",
    ];
    for table in tables {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "historical fixtures must not erase scan decisions: {table}"
        );
    }
    for trigger in [
        "instruction_refuses_tracker_scan",
        "ordinary_input_refuses_tracker_scan",
    ] {
        sqlx::query(&format!("DROP TRIGGER {trigger}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    for table in tables {
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("DROP INDEX tracker_timer_guard_scope")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DROP INDEX tracker_canonical_claim_scope")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=75")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}
