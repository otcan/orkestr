//! Historical migration fixtures contain no retirement decisions. Reconstruct
//! the exact prior schema from its migrations rather than approximating it.
use crate::Store;
use sqlx::{Connection, SqliteConnection};

pub(in crate::production_runtime) async fn downgrade(store: &Store) {
    let decisions: i64 = sqlx::query_scalar("SELECT count(*) FROM owner_input_retirements")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(decisions, 0, "fixture must not erase owner decisions");
    let mut reference = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    for migration in sqlx::migrate!("./migrations")
        .iter()
        .filter(|m| m.version < 70)
    {
        sqlx::raw_sql(&migration.sql)
            .execute(&mut reference)
            .await
            .unwrap();
    }
    let table: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='reasoning_inbox'")
            .fetch_one(&mut reference)
            .await
            .unwrap();
    let metadata_table: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='production_resume_metadata'")
            .fetch_one(&mut reference)
            .await
            .unwrap();
    let rest: Vec<String> = sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name IN ('inbox_lease','execution_inbox_insert','execution_inbox_update','ordinary_input_holds') ORDER BY type,name")
        .fetch_all(&mut reference).await.unwrap();
    reference.close().await.unwrap();
    let mut tx = store.pool.begin().await.unwrap();
    for statement in [
        "PRAGMA defer_foreign_keys=ON",
        "DROP VIEW ordinary_input_holds",
        "DROP TABLE owner_input_retirements",
        "CREATE TEMP TABLE inbox_copy AS SELECT * FROM reasoning_inbox",
        "DROP TABLE reasoning_inbox",
        &table,
        "INSERT INTO reasoning_inbox SELECT * FROM inbox_copy",
        "DROP TABLE inbox_copy",
        "CREATE TEMP TABLE metadata_copy AS SELECT * FROM production_resume_metadata",
        "DROP TABLE production_resume_metadata",
        &metadata_table,
        "INSERT INTO production_resume_metadata SELECT * FROM metadata_copy",
        "DROP TABLE metadata_copy",
        "DELETE FROM _sqlx_migrations WHERE version>=70",
    ] {
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
    }
    for statement in rest {
        sqlx::query(&statement).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
}
