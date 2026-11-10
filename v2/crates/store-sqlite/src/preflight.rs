//! Inspect an expendable DB/WAL copy before SQLite can touch an existing source.
//! Caller controls the directory; this is not a concurrent backup or filesystem sandbox.
use super::{db, Result, StoreError};
use sqlx::{migrate::Migrate, sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use uuid::Uuid;

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
impl Scratch {
    fn new(parent: &Path) -> Result<Self> {
        let path = parent.join(format!(".intake-preflight-{}", Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(db)?;
        Ok(Self(path))
    }
}
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

/// Returns true only for an atomically created new file. Existing empty files
/// are foreign; an interrupted initialization requires explicit reconciliation.
pub(super) async fn prepare(path: &Path) -> Result<bool> {
    if !path.try_exists().map_err(db)? {
        for suffix in ["-wal", "-shm", "-journal"] {
            if sidecar(path, suffix).try_exists().map_err(db)? {
                return Err(StoreError::Invalid);
            }
        }
    }
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => {
            drop(file);
            return Ok(true);
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(db(error)),
    }
    // WAL stores have no rollback journal. Never recover a foreign hot journal.
    if sidecar(path, "-journal").try_exists().map_err(db)? {
        return Err(StoreError::Invalid);
    }
    let scratch = Scratch::new(path.parent().ok_or(StoreError::Invalid)?)?;
    let copied = scratch.0.join("probe.sqlite3");
    fs::copy(path, &copied).map_err(db)?;
    match fs::copy(sidecar(path, "-wal"), sidecar(&copied, "-wal")) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(db(error)),
    }
    // Rebuild SHM only on the expendable copy. read_only on the source alone is
    // insufficient: SQLite may create or modify source sidecars on a refused open.
    let mut probe = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&copied)
            .read_only(true)
            .create_if_missing(false),
    )
    .await
    .map_err(db)?;
    let result = identify(&mut probe).await;
    let closed = probe.close().await.map_err(db);
    result?;
    closed?;
    Ok(false)
}

async fn schema(connection: &mut SqliteConnection) -> Result<Vec<(String, String, String)>> {
    let rows = sqlx::query(
        "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name",
    )
    .fetch_all(connection)
    .await
    .map_err(db)?;
    Ok(rows
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect())
}
async fn identify(probe: &mut SqliteConnection) -> Result<()> {
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut *probe)
        .await
        .map_err(db)?;
    if mode != "wal" {
        return Err(StoreError::Invalid);
    }
    let rows = sqlx::query(
        "SELECT version,description,success,checksum FROM _sqlx_migrations ORDER BY version",
    )
    .fetch_all(&mut *probe)
    .await
    .map_err(db)?;
    let migrator = sqlx::migrate!("./migrations");
    if rows.is_empty() || rows.len() > migrator.iter().count() {
        return Err(StoreError::Invalid);
    }
    let mut expected = SqliteConnection::connect("sqlite::memory:")
        .await
        .map_err(db)?;
    expected.ensure_migrations_table().await.map_err(db)?;
    for (row, migration) in rows.iter().zip(migrator.iter()) {
        if row.get::<i64, _>("version") != migration.version
            || row.get::<String, _>("description").as_str() != migration.description.as_ref()
            || !row.get::<bool, _>("success")
            || row.get::<Vec<u8>, _>("checksum").as_slice() != migration.checksum.as_ref()
        {
            return Err(StoreError::Invalid);
        }
        sqlx::raw_sql(&migration.sql)
            .execute(&mut expected)
            .await
            .map_err(db)?;
    }
    // Includes tables, triggers, explicit indexes and SQLx's own metadata table.
    // A supported earlier prefix can migrate only after its schema is identified.
    let matches = schema(probe).await? == schema(&mut expected).await?;
    expected.close().await.map_err(db)?;
    if matches {
        Ok(())
    } else {
        Err(StoreError::Invalid)
    }
}

#[cfg(test)]
mod tests;
