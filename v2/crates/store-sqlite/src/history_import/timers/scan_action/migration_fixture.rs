//! Historical fixtures may remove only empty scan-action data.
use crate::Store;

pub(crate) async fn downgrade_empty(store: &Store) {
    let mut tx = store.pool.begin().await.unwrap();
    // Migration 82 down: only with no live parallel Deep slot and the switch
    // off everywhere, restore the 80 canonical index and drop the columns.
    let slots: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM session_bindings WHERE deep_slot>0 AND state!='retired')+(SELECT count(*) FROM conversation_settings WHERE parallel_deep!=0)",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(
        slots, 0,
        "historical fixture must not erase parallel Deep slots or the switch"
    );
    sqlx::raw_sql("DROP TABLE production_parallel_deep_slots; ALTER TABLE conversation_settings DROP COLUMN parallel_deep; DROP INDEX canonical_role; ALTER TABLE session_bindings DROP COLUMN deep_slot; CREATE UNIQUE INDEX canonical_role ON session_bindings(owner_id, conversation_id, role, fast_slot)\n WHERE role IN ('fast','deep') AND state <> 'retired';")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=82")
        .execute(&mut *tx)
        .await
        .unwrap();
    // Migration 81 down: the Deep grouping switch is a preference only.
    sqlx::raw_sql("ALTER TABLE conversation_settings DROP COLUMN deep_grouping;")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=81")
        .execute(&mut *tx)
        .await
        .unwrap();
    // Migration 80 down: only with no live auxiliary Fast slot, restore the
    // single canonical Fast/Deep index and drop the slot column.
    let slots: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM session_bindings WHERE fast_slot>0 AND state!='retired'",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(
        slots, 0,
        "historical fixture must not erase live Fast slots"
    );
    sqlx::raw_sql("ALTER TABLE conversation_fast_settings DROP COLUMN parallel_replies; DROP INDEX canonical_role; ALTER TABLE session_bindings DROP COLUMN fast_slot; CREATE UNIQUE INDEX canonical_role ON session_bindings(owner_id, conversation_id, role)\n WHERE role IN ('fast','deep') AND state <> 'retired';")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=80")
        .execute(&mut *tx)
        .await
        .unwrap();
    // Migration 79 down: only empty agent-timer tables.
    for table in ["agent_timer_audit", "agent_timers", "agent_timer_grants"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(count, 0, "historical fixture must not erase agent timers");
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=79")
        .execute(&mut *tx)
        .await
        .unwrap();
    for table in [
        "message_authors",
        "thread_ask_audit",
        "thread_asks",
        "thread_ask_grants",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(count, 0, "historical fixture must not erase thread asks");
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=78")
        .execute(&mut *tx)
        .await
        .unwrap();
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
