//! Test-only empty window guards and faithful pre-42 session fixtures.
//! No window/dispatch authority is seeded. Removed before Store::open, with exact schema and
//! SQLx inventory restoration checked. Never compiled into the application.
use crate::Store;

/// Admission re-checks an input's source continuation, reading two tables the
/// historical schema lacks. CHECK(0) forbids every insert: none can exist.
const SOURCE_GUARDS: [(&str, &str); 2] = [
    (
        "source_admission_fences",
        "CREATE TABLE source_admission_fences (message_id TEXT CHECK(0), source_run_id TEXT, expected_provider_generation INTEGER, source_native_session_id TEXT, source_provider TEXT, source_binding_generation INTEGER)",
    ),
    (
        "conversation_settings",
        "CREATE TABLE conversation_settings (owner_id TEXT CHECK(0), conversation_id TEXT, provider_generation INTEGER)",
    ),
];

pub(super) struct HistoricalGuardFixture {
    schema: Vec<(String, String, String, Option<String>)>,
    migrations: Vec<(i64, String, String, i64, String, i64)>,
}
impl HistoricalGuardFixture {
    /// The historical schema has no session-kind column. Reproduce its actual
    /// row shape instead of making the current product accept an old schema.
    pub(super) async fn save_session(
        &self,
        store: &Store,
        token: &str,
        owner: &orkestr_v2_contracts::OwnerId,
    ) {
        sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,expires_at) VALUES(?,?,unixepoch()+43200)")
            .bind(crate::digest(token)).bind(owner.to_string()).execute(&store.pool).await.unwrap();
    }
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
        assert!(schema
            .iter()
            .all(|(_, name, _, _)| name != "execution_windows"
                && name != "execution_window_inputs"
                && !SOURCE_GUARDS.iter().any(|(guard, _)| name == guard)));
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
        for (_, create) in SOURCE_GUARDS {
            sqlx::query(create).execute(&store.pool).await.unwrap();
        }
        Self { schema, migrations }
    }
    pub(super) async fn remove(self, store: &Store) {
        for (guard, _) in SOURCE_GUARDS {
            let rows: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {guard}"))
                .fetch_one(&store.pool)
                .await
                .unwrap();
            assert_eq!(rows, 0, "{guard}");
            sqlx::query(&format!("DROP TABLE {guard}"))
                .execute(&store.pool)
                .await
                .unwrap();
        }
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
