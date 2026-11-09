//! Engine identity and real Store compatibility; not an exploit reproduction.
use super::*;
struct Directory(std::path::PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::path::PathBuf::from(
            std::env::var_os("ORKESTR_V2_HOME").expect("isolated test home"),
        )
        .join(format!("sqlite-security-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn database(&self) -> std::path::PathBuf {
        self.0.join("core.sqlite3")
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[tokio::test]
async fn linked_bundled_engine_contains_the_wal_page_initialization_fix() {
    let dir = Directory::new();
    let store = Store::open(&dir.database()).await.unwrap();
    let version: String = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        version, "3.54.1",
        "verify linked engine, not only Cargo.lock"
    );
    store.close().await;
}
#[tokio::test]
async fn real_migrations_full_wal_commit_rollback_and_current_reopen_survive_upgrade() {
    let dir = Directory::new();
    let path = dir.database();
    let store = Store::open(&path).await.unwrap();
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(mode.to_lowercase(), "wal");
    assert_eq!(synchronous, 2);
    let owner = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO owners(id,username,password_hash) VALUES (?,?,?)")
        .bind(&owner)
        .bind("synthetic-security-owner")
        .bind("committed")
        .execute(&store.pool)
        .await
        .unwrap();
    let mut transaction = store.pool.begin().await.unwrap();
    sqlx::query("UPDATE owners SET password_hash='rolled-back' WHERE id=?")
        .bind(&owner)
        .execute(&mut *transaction)
        .await
        .unwrap();
    transaction.rollback().await.unwrap();
    let migrations: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        migrations as usize,
        sqlx::migrate!("./migrations").iter().count()
    );
    store.close().await;
    for current in [true, false] {
        let reopened = if current {
            Store::open_current(&path).await.unwrap()
        } else {
            Store::open(&path).await.unwrap()
        };
        let value: String = sqlx::query_scalar("SELECT password_hash FROM owners WHERE id=?")
            .bind(&owner)
            .fetch_one(&reopened.pool)
            .await
            .unwrap();
        assert_eq!(value, "committed");
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&reopened.pool)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");
        reopened.close().await;
    }
}
