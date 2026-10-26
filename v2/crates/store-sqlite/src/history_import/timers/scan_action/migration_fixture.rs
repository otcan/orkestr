//! Historical fixtures may remove only empty scan-action data.
use crate::Store;

pub(crate) async fn downgrade_empty(store: &Store) {
    let mut tx = store.pool.begin().await.unwrap();
    for table in ["production_fast_digests", "production_fast_continuity"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "historical fixture must not erase Fast continuity"
        );
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=77")
        .execute(&mut *tx)
        .await
        .unwrap();
    let fast_settings: i64 = sqlx::query_scalar("SELECT count(*) FROM conversation_fast_settings")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        fast_settings, 0,
        "historical fixtures must not erase Fast preferences"
    );
    sqlx::query("DROP TABLE conversation_fast_settings")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=76")
        .execute(&mut *tx)
        .await
        .unwrap();
    let tables = [
        "tracker_discovery_receipts",
        "tracker_automation_decisions",
        "tracker_automation_settings",
        "tracker_local_sources",
        "tracker_check_cancellations",
        "tracker_manual_checks",
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
