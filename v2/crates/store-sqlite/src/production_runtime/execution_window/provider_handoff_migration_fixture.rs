//! Test-only exact empty schema-73 removal for historical upgrade producers.
use super::{db, Result};
use crate::Store;
use sqlx::SqliteConnection;

pub(crate) async fn legacy_dispatch_fixture(tx: &mut SqliteConnection) -> Result<bool> {
    let version: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    let tables: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('conversation_provider_handoffs','conversation_handoff_sessions','conversation_handoff_context_delivery')")
        .fetch_one(&mut *tx).await.map_err(db)?;
    Ok(version < 73 && tables == 0)
}

pub(in crate::production_runtime) async fn downgrade_empty(store: &Store) {
    let mut tx = store.pool.begin().await.unwrap();
    for table in [
        "conversation_handoff_context_delivery",
        "conversation_handoff_sessions",
        "conversation_provider_handoffs",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "historical fixtures must not erase handoff decisions or context"
        );
    }
    for statement in [
        "DROP TABLE conversation_handoff_context_delivery",
        "DROP TABLE conversation_handoff_sessions",
        "DROP TABLE conversation_provider_handoffs",
        "DELETE FROM _sqlx_migrations WHERE version=73",
    ] {
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
}
