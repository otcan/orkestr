//! Populated prefix14 -> acceptance migration15; copies only caller-owned synthetic inputs.
use orkestr_v2_store_sqlite::Store;
use serde_json::Value;
use sqlx::{Connection, Row};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use uuid::Uuid;
type Rows = BTreeMap<String, Vec<Value>>;
async fn snapshot(root: &Path) -> Rows {
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.join("core.sqlite3"))
            .read_only(true),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA query_only=ON")
        .execute(&mut db)
        .await
        .unwrap();
    let mut tx = db.begin().await.unwrap();
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *tx)
        .await
        .unwrap();
    assert!(violations.is_empty(), "foreign key violation");
    let names:Vec<String>=sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(&mut *tx).await.unwrap();
    let mut result = Rows::new();
    for table in names {
        // Names originate only from the controlled schema, never request input.
        assert!(table
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_'));
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap()
            .iter()
            .map(|r| {
                let s: String = r.get("name");
                format!("'{s}',CASE WHEN typeof(\"{s}\")='blob' THEN json_object('blob_hex',hex(\"{s}\")) ELSE \"{s}\" END")
            })
            .collect::<Vec<_>>()
            .join(",");
        let values: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT json_object({columns}) FROM {table} ORDER BY rowid"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        result.insert(
            table,
            values
                .into_iter()
                .map(|v| serde_json::from_str(&v).unwrap())
                .collect(),
        );
    }
    tx.commit().await.unwrap();
    db.close().await.unwrap();
    result
}
#[tokio::test]
async fn independent_populated_prefix14_acceptance_upgrade_preserves_all_prior_rows_and_fks() {
    let sources = std::env::var_os("ORKESTR_V2_PREFIX14_SOURCES")
        .expect("explicit owned synthetic prefix14 source directories required");
    let sources: Vec<_> = std::env::split_paths(&sources).collect();
    assert!(!sources.is_empty());
    let home = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"));
    for source in sources {
        assert!(source.is_absolute());
        let root = home.join(format!("upgrade-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        // Source children must already have exited. Copy before opening either DB.
        for suffix in ["", "-wal", "-shm"] {
            let name = format!("core.sqlite3{suffix}");
            let path = source.join(&name);
            if path.exists() {
                assert!(std::fs::symlink_metadata(&path).unwrap().is_file());
                std::fs::copy(path, root.join(name)).unwrap();
            }
        }
        let before = snapshot(&root).await;
        let migrations = &before["_sqlx_migrations"];
        assert_eq!(migrations.len(), 14);
        assert_eq!(migrations.last().unwrap()["version"], 14);
        assert!(!before["events"].is_empty());
        assert!(!before["production_runs"].is_empty());
        assert!(!before["production_observations"].is_empty());
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        store.close().await;
        let mut after = snapshot(&root).await;
        assert_eq!(after.remove("production_acceptances").unwrap().len(), 0);
        let new = after.get_mut("_sqlx_migrations").unwrap();
        assert_eq!(new.len(), 15);
        assert_eq!(new.last().unwrap()["version"], 15);
        assert_eq!(new.last().unwrap()["success"], 1);
        new.pop();
        assert!(
            after == before,
            "acceptance migration altered populated historical rows"
        );
    }
}
