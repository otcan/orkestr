use orkestr_v2_store_sqlite::Store;
use sqlx::{Connection, SqliteConnection};
use std::collections::BTreeMap;

fn files(dir: &std::path::Path) -> BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().to_string_lossy().into(),
                std::fs::read(entry.path()).unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn unrelated_future_and_empty_databases_are_not_mutated() {
    for setup in [
        "CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES ('preserve');",
        "PRAGMA application_id=1330793266; PRAGMA user_version=999;",
        "",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("foreign.sqlite");
        let mut conn = SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        if !setup.is_empty() {
            sqlx::raw_sql(setup).execute(&mut conn).await.unwrap();
        }
        conn.close().await.unwrap();
        let before = files(dir.path());
        assert!(Store::open(&path).await.is_err());
        assert!(
            files(dir.path()) == before,
            "source database or sidecars changed"
        );
    }
}

#[tokio::test]
async fn newer_version_of_real_journal_refused_without_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    Store::open(&path).await.unwrap().close().await.unwrap();
    let mut conn =
        SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
    sqlx::query("PRAGMA user_version=2")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    let before = files(dir.path());
    assert!(Store::open(&path).await.is_err());
    assert!(
        files(dir.path()) == before,
        "source database or sidecars changed"
    );
}

#[tokio::test]
async fn unrelated_wal_database_is_not_mutated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("foreign.sqlite");
    let mut conn = SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES ('preserve');")
        .execute(&mut conn)
        .await
        .unwrap();
    let before = files(dir.path());
    assert!(Store::open(&path).await.is_err());
    assert!(
        files(dir.path()) == before,
        "source database or sidecars changed"
    );
    conn.close().await.unwrap();
}

#[tokio::test]
async fn newer_version_in_uncheckpointed_wal_refused_without_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    Store::open(&path).await.unwrap().close().await.unwrap();
    let mut conn =
        SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
    sqlx::query("PRAGMA wal_autocheckpoint=0")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("PRAGMA user_version=2")
        .execute(&mut conn)
        .await
        .unwrap();
    let before = files(dir.path());
    assert!(before.contains_key("journal.sqlite-wal"));
    assert_eq!(&before["journal.sqlite"][60..64], &1_u32.to_be_bytes());
    assert!(Store::open(&path).await.is_err());
    assert!(
        files(dir.path()) == before,
        "source database or sidecars changed"
    );
    conn.close().await.unwrap();
}

#[tokio::test]
async fn altered_schema_is_not_adopted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    Store::open(&path).await.unwrap().close().await.unwrap();
    let mut conn =
        SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
    sqlx::query("ALTER TABLE journal ADD COLUMN unexpected TEXT")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    let before = files(dir.path());
    assert!(Store::open(&path).await.is_err());
    assert!(
        files(dir.path()) == before,
        "source database or sidecars changed"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_database_is_refused_without_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    Store::open(&path).await.unwrap().close().await.unwrap();
    let link = dir.path().join("link.sqlite");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    let before = files(dir.path());
    assert!(Store::open(&link).await.is_err());
    assert!(
        files(dir.path()) == before,
        "source database or sidecars changed"
    );
}
