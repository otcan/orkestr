//! Offline metadata journal. No discovery of legacy homes, credentials or effects.
//! This is not the authenticated M1 command API. Only explicit synthetic paths.
mod projection;
mod schema;

use orkestr_v2_domain::{ApplyError, ApplyResult, Engine, JournalRecord, SCHEMA_VERSION};
use sqlx::{Connection, Row, SqliteConnection};
use std::path::Path;
use tokio::sync::Mutex;

pub use projection::Snapshot;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database operation failed: {0}")]
    Sql(#[from] sqlx::Error),
    #[error("filesystem operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid journal encoding: {0}")]
    Json(#[from] serde_json::Error),
    #[error("domain transition rejected: {0:?}")]
    Domain(ApplyError),
    #[error("unsupported journal record version: {0}")]
    RecordVersion(u32),
    #[error("not a supported v2 journal database")]
    DatabaseIdentity,
    #[error("journal integrity violation")]
    CorruptJournal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendReceipt {
    pub sequence: i64,
    pub duplicate: bool,
}

/// Each handle has its own connection. SQLite serializes independent writers.
/// Dropped/cancelled transactions are rolled back by SQLx, not manually retained.
pub struct Store {
    connection: Mutex<SqliteConnection>,
}

impl Store {
    /// Create a new database or open an identified v1 journal. Never adopt an
    /// unrelated database, including a pre-existing empty file.
    /// Validates the journal; call replay to repair independently damaged projections.
    /// An interrupted first initialization remains refused, not silently adopted.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let mut connection = schema::open(path.as_ref()).await?;
        // Validate authoritative records before returning a usable handle.
        let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
        load(&mut tx).await?;
        tx.commit().await?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub async fn append(&self, record: &JournalRecord) -> Result<AppendReceipt, Error> {
        check_version(record)?;
        let mut connection = self.connection.lock().await;
        let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
        let (mut engine, _) = load(&mut tx).await?;
        if let Some(row) = sqlx::query("SELECT sequence, record FROM journal WHERE event_id = ?")
            .bind(&record.envelope.event_id)
            .fetch_optional(&mut *tx)
            .await?
        {
            let previous: JournalRecord = serde_json::from_str(row.try_get("record")?)?;
            if previous != *record {
                return Err(Error::Domain(ApplyError::ConflictingEventId));
            }
            let sequence = row.try_get("sequence")?;
            tx.commit().await?;
            return Ok(AppendReceipt {
                sequence,
                duplicate: true,
            });
        }
        engine
            .apply(record.envelope.clone())
            .map_err(Error::Domain)?;
        let sequence = sqlx::query("INSERT INTO journal(event_id, record) VALUES (?, ?)")
            .bind(&record.envelope.event_id)
            .bind(serde_json::to_string(record)?)
            .execute(&mut *tx)
            .await?
            .last_insert_rowid();
        projection::replace(&mut tx, &engine, sequence).await?;
        #[cfg(test)]
        crash::checkpoint("before_commit");
        tx.commit().await?;
        #[cfg(test)]
        crash::checkpoint("after_commit");
        Ok(AppendReceipt {
            sequence,
            duplicate: false,
        })
    }

    /// Rebuild projections in one transaction; validation precedes any deletion.
    /// No tool, worker or effect is invoked by replay.
    pub async fn replay(&self) -> Result<Snapshot, Error> {
        let mut connection = self.connection.lock().await;
        let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
        let (engine, sequence) = load(&mut tx).await?;
        projection::replace(&mut tx, &engine, sequence).await?;
        let snapshot = Snapshot::from_engine(engine, sequence);
        tx.commit().await?;
        Ok(snapshot)
    }

    /// A consistent view of persisted projections, not an in-memory cache.
    pub async fn snapshot(&self) -> Result<Snapshot, Error> {
        let mut connection = self.connection.lock().await;
        let mut tx = connection.begin().await?;
        let snapshot = projection::read(&mut tx).await?;
        tx.commit().await?;
        Ok(snapshot)
    }

    pub async fn close(self) -> Result<(), Error> {
        self.connection.into_inner().close().await?;
        Ok(())
    }
}

fn check_version(record: &JournalRecord) -> Result<(), Error> {
    if record.schema_version != SCHEMA_VERSION {
        return Err(Error::RecordVersion(record.schema_version));
    }
    Ok(())
}

async fn load(connection: &mut SqliteConnection) -> Result<(Engine, i64), Error> {
    let rows = sqlx::query("SELECT sequence, event_id, record FROM journal ORDER BY sequence")
        .fetch_all(&mut *connection)
        .await?;
    let mut engine = Engine::new();
    let mut sequence = 0;
    for row in rows {
        let next: i64 = row.try_get("sequence")?;
        let record: JournalRecord = serde_json::from_str(row.try_get("record")?)?;
        check_version(&record)?;
        if next != sequence + 1
            || record.envelope.event_id != row.try_get::<String, _>("event_id")?
        {
            return Err(Error::CorruptJournal);
        }
        if engine.apply(record.envelope).map_err(Error::Domain)? != ApplyResult::Applied {
            return Err(Error::CorruptJournal);
        }
        sequence = next;
    }
    Ok((engine, sequence))
}

#[cfg(test)]
mod crash;

#[cfg(test)]
mod settings_tests {
    use super::*;
    #[tokio::test]
    async fn connection_requires_full_sync_and_foreign_keys() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("settings.sqlite"))
            .await
            .unwrap();
        let mut connection = store.connection.lock().await;
        let sync: i64 = sqlx::query_scalar("PRAGMA synchronous")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        let foreign: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        assert_eq!(sync, 2);
        assert_eq!(foreign, 1);
    }
    #[tokio::test]
    async fn cancelled_transaction_does_not_poison_the_connection() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            std::sync::Arc::new(Store::open(dir.path().join("cancel.sqlite")).await.unwrap());
        let (entered, ready) = tokio::sync::oneshot::channel();
        let writer = store.clone();
        let task = tokio::spawn(async move {
            let mut connection = writer.connection.lock().await;
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await.unwrap();
            sqlx::query("INSERT INTO journal VALUES (1, 'uncommitted', 'invalid')")
                .execute(&mut *tx)
                .await
                .unwrap();
            entered.send(()).unwrap();
            std::future::pending::<()>().await;
            tx.commit().await.unwrap();
        });
        ready.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(store.replay().await.unwrap().sequence, 0);
    }
}
