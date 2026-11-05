//! Test-only conversion of empty post-85 feature tables to a historical fixture.
//! This is never compiled into the product or used on an operational Core.
use crate::Store;

pub(super) async fn downgrade_empty(store: &Store) {
    let mut tx = store.pool.begin().await.unwrap();
    for table in [
        "managed_operations",
        "operator_provider_handoffs",
        "conversation_provider_policy_matches",
        "deep_desk_results",
        "deep_desk_operations",
        "source_admission_fences",
        "message_request_sources",
        "encrypted_upload_chunks",
        "encrypted_uploads",
        "service_credentials",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(count, 0, "historical fixture must not erase {table}");
    }
    let service_sessions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM auth_sessions WHERE kind='service_browser' OR service_credential_id IS NOT NULL",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(
        service_sessions, 0,
        "historical fixture has service sessions"
    );
    // Historical sessions have no distinguishable transport; the 86 upgrade
    // must faithfully reclassify these synthetic hashes as legacy.
    sqlx::raw_sql(
        "DROP TABLE managed_operations;
         DELETE FROM _sqlx_migrations WHERE version=93;
         DROP TABLE operator_provider_handoffs;
         DROP TABLE conversation_provider_policy_matches;
         DELETE FROM _sqlx_migrations WHERE version=92;
         DROP TABLE deep_desk_results;
         DROP TABLE deep_desk_operations;
         DELETE FROM _sqlx_migrations WHERE version=91;
         DROP TABLE source_admission_fences;
         DROP TABLE message_request_sources;
         DROP INDEX encrypted_upload_receipt_cover;
         DROP TABLE encrypted_upload_chunks;
         DROP TABLE encrypted_uploads;
         ALTER TABLE auth_sessions DROP COLUMN service_credential_id;
         ALTER TABLE auth_sessions DROP COLUMN kind;
         DROP TABLE service_credentials;
         DELETE FROM _sqlx_migrations WHERE version BETWEEN 86 AND 90;",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}
