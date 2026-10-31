use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;
use sqlx::{
    migrate::Migrate,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    Connection, SqliteConnection,
};

async fn rows(store: &Store, tables: &[String]) -> Vec<Vec<String>> {
    let mut result = Vec::new();
    for table in tables {
        let columns = sqlx::query(&format!("PRAGMA table_info(\"{table}\")"))
            .fetch_all(&store.pool)
            .await
            .unwrap();
        let projection = columns
            .iter()
            .map(|row| format!("quote(\"{}\")", row.get::<String, _>("name")))
            .collect::<Vec<_>>()
            .join(",");
        let query = format!("SELECT json_array({projection}) FROM \"{table}\" ORDER BY 1");
        result.push(
            sqlx::query_scalar(&query)
                .fetch_all(&store.pool)
                .await
                .unwrap(),
        );
    }
    result
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn populated_schema44_copy_first_upgrade_preserves_every_old_row_and_has_no_exec_authority() {
    let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("workspace-exec-upgrade-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let options = SqliteConnectOptions::new()
        .filename(root.join("core.sqlite3"))
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    connection.ensure_migrations_table().await.unwrap();
    for migration in sqlx::migrate!("./migrations")
        .iter()
        .take_while(|migration| migration.version < 45)
    {
        connection.apply(migration).await.unwrap();
    }
    connection.close().await.unwrap();
    let store = Store {
        pool: SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .unwrap(),
        authority: None,
        workspace_handles: Default::default(),
        #[cfg(feature = "fixture-test-controls")]
        production_checkpoint: None,
        deep_burst_quiet_ms: 0,
    };
    let conversation = store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: Uuid::new_v4().to_string(),
                text: "Historical owner input is not permission to execute a command".into(),
            },
        )
        .await
        .unwrap();
    let tables:Vec<String>=sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_sqlx_migrations' ORDER BY name").fetch_all(&store.pool).await.unwrap();
    let before = rows(&store, &tables).await;
    store.close().await;
    let upgraded = Store::open(&root.join("core.sqlite3")).await.unwrap();
    assert_eq!(rows(&upgraded, &tables).await, before);
    for table in [
        "workspace_exec_profiles",
        "workspace_exec_delegations",
        "workspace_exec_results",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&upgraded.pool)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "historical data cannot opt into a new command capability"
        );
    }
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&upgraded.pool)
        .await
        .unwrap();
    assert!(violations.is_empty());
    upgraded.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
