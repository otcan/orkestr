//! Test-only EMPTY guard scaffold for pre-42 typed upgrade producers.
//! No authority is seeded. Removed before Store::open, with exact schema and
//! SQLx inventory restoration checked. Never compiled into the application.
use crate::Store;

pub(super) struct HistoricalGuardFixture {
    schema: Vec<(String, String, String, Option<String>)>,
    migrations: Vec<(i64, String, String, i64, String, i64)>,
}
impl HistoricalGuardFixture {
    pub(super) async fn install(store: &Store, version: i64) -> Self {
        assert!(matches!(version, 30 | 31));
        let schema = schema(store).await;
        let migrations = migrations(store).await;
        let expected: Vec<_> = sqlx::migrate!("./migrations")
            .iter()
            .filter(|m| m.version <= version)
            .map(|m| (m.version, m.description.to_string(), m.checksum.to_vec()))
            .collect();
        let actual: Vec<(i64, String, Vec<u8>)> = sqlx::query_as(
            "SELECT version,description,checksum FROM _sqlx_migrations WHERE success=1 ORDER BY version")
            .fetch_all(&store.pool).await.unwrap();
        assert_eq!(actual, expected, "exact historical SQLx prefix required");
        assert!(schema.iter().all(
            |(_, name, _, _)| name != "execution_windows" && name != "execution_window_inputs"
        ));
        // CHECK(0) forbids every insert: no window/credential authority can exist.
        sqlx::query("CREATE TABLE execution_windows (credential_hash TEXT CHECK(0))")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE execution_window_inputs (window_id TEXT, event_id TEXT CHECK(0))",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        Self { schema, migrations }
    }
    pub(super) async fn remove(self, store: &Store) {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_windows")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let inputs: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_window_inputs")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(inputs, 0);
        sqlx::query("DROP TABLE execution_window_inputs")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("DROP TABLE execution_windows")
            .execute(&store.pool)
            .await
            .unwrap();
        assert_eq!(
            schema(store).await,
            self.schema,
            "historical schema restored"
        );
        assert_eq!(
            migrations(store).await,
            self.migrations,
            "SQLx inventory unchanged"
        );
    }
}
async fn schema(store: &Store) -> Vec<(String, String, String, Option<String>)> {
    sqlx::query_as("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .fetch_all(&store.pool)
        .await
        .unwrap()
}
async fn migrations(store: &Store) -> Vec<(i64, String, String, i64, String, i64)> {
    sqlx::query_as("SELECT version,description,CAST(installed_on AS TEXT),success,hex(checksum),execution_time FROM _sqlx_migrations ORDER BY version")
        .fetch_all(&store.pool).await.unwrap()
}
