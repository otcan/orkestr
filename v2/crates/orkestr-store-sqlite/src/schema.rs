use crate::Error;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use sqlx::{Connection, Row, SqliteConnection};
use std::{fs::OpenOptions, path::Path, time::Duration};

const APPLICATION_ID: i64 = 0x4f524b32;
const DATABASE_VERSION: i64 = 1;

pub(crate) async fn open(path: &Path) -> Result<SqliteConnection, Error> {
    // Atomic file creation avoids silently adopting an empty/unrelated SQLite file.
    let created = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => {
            drop(file);
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(e) => return Err(e.into()),
    };
    let base = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    if !std::fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(Error::DatabaseIdentity);
    }
    if !created {
        preflight_copy(path, &base).await?;
    }
    // Do not request a journal-mode change while connecting to an existing file.
    let options = if created {
        base.clone().journal_mode(SqliteJournalMode::Wal)
    } else {
        base
    };
    let mut connection =
        SqliteConnection::connect_with(&options.synchronous(SqliteSynchronous::Full)).await?;
    if !created {
        identify(&mut connection).await?;
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&mut connection)
            .await?;
        if mode != "wal" {
            return Err(Error::DatabaseIdentity);
        }
    }
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
    if created {
        sqlx::raw_sql(SCHEMA).execute(&mut *tx).await?;
        sqlx::query(&format!("PRAGMA application_id = {APPLICATION_ID}"))
            .execute(&mut *tx)
            .await?;
        sqlx::query(&format!("PRAGMA user_version = {DATABASE_VERSION}"))
            .execute(&mut *tx)
            .await?;
    } else {
        identify(&mut tx).await?;
    }
    tx.commit().await?;
    Ok(connection)
}

/// SQLite read_only alone may create WAL/SHM files. Inspect an expendable copy
/// first so refusing an unrelated/future store never opens that source in SQLite.
/// This is not a concurrent backup API: a racing schema/init or incomplete copy
/// fails closed. Callers own the path and must not replace/migrate it while open.
async fn preflight_copy(path: &Path, base: &SqliteConnectOptions) -> Result<(), Error> {
    let temp = tempfile::tempdir()?;
    let copied = temp.path().join("preflight.sqlite");
    std::fs::copy(path, &copied)?;
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    if let Ok(metadata) = std::fs::symlink_metadata(Path::new(&wal)) {
        if !metadata.file_type().is_file() {
            return Err(Error::DatabaseIdentity);
        }
    }
    match std::fs::copy(Path::new(&wal), temp.path().join("preflight.sqlite-wal")) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let mut probe =
        SqliteConnection::connect_with(&base.clone().filename(copied).read_only(true)).await?;
    let result = identify(&mut probe).await;
    probe.close().await?;
    result
}

async fn identify(connection: &mut SqliteConnection) -> Result<(), Error> {
    let app: i64 = sqlx::query_scalar("PRAGMA application_id")
        .fetch_one(&mut *connection)
        .await?;
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *connection)
        .await?;
    if app != APPLICATION_ID || version != DATABASE_VERSION {
        return Err(Error::DatabaseIdentity);
    }
    let rows = sqlx::query("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY sql")
        .fetch_all(&mut *connection)
        .await?;
    let actual: Vec<String> = rows.iter().map(|row| row.get("sql")).collect();
    let mut expected: Vec<String> = SCHEMA
        .split(';')
        .map(str::trim)
        .filter(|statement| statement.starts_with("CREATE TABLE"))
        .map(str::to_owned)
        .collect();
    expected.sort();
    if actual != expected {
        return Err(Error::DatabaseIdentity);
    }
    Ok(())
}

const SCHEMA: &str = "
CREATE TABLE journal (
    sequence INTEGER PRIMARY KEY CHECK(sequence > 0),
    event_id TEXT NOT NULL UNIQUE,
    record TEXT NOT NULL
) STRICT;
CREATE TABLE conversations (
    id TEXT PRIMARY KEY NOT NULL,
    data TEXT NOT NULL
) STRICT;
CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    data TEXT NOT NULL
) STRICT;
CREATE TABLE projection_cursor (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    sequence INTEGER NOT NULL CHECK(sequence >= 0)
) STRICT;
INSERT INTO projection_cursor VALUES (1, 0);
";
