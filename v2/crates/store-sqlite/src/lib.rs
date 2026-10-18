//! Authoritative v2 SQLite adapter. FULL synchronous WAL commits precede receipts.
use orkestr_v2_application::{Result, StoreError};
use orkestr_v2_contracts::*;
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Row, SqlitePool,
};
use std::{path::Path, time::Duration};
use uuid::Uuid;
pub mod fixture_runtime;
mod intake;
mod paths;
mod preflight;
mod production_runtime;
mod replay;
mod runtime;
pub use production_runtime::{
    ConsumedProviderDispatch, ExecutionConsumption, ProductionSupervisorStore,
};

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
    authority: Option<production_runtime::Context>,
}
fn db(_: impl std::fmt::Display) -> StoreError {
    StoreError::Unavailable
}
fn digest(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn parse(s: String) -> Result<Uuid> {
    Uuid::parse_str(&s).map_err(db)
}
impl Store {
    pub async fn open(path: &Path) -> Result<Self> {
        paths::validate(path)?;
        let created = preflight::prepare(path).await?;
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .foreign_keys(true)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let options = if created {
            options.journal_mode(SqliteJournalMode::Wal)
        } else {
            options
        };
        let pool = SqlitePoolOptions::new()
            .max_connections(6)
            .connect_with(options)
            .await
            .map_err(db)?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(db)?;
        Ok(Self {
            pool,
            authority: None,
        })
    }
    pub async fn close(&self) {
        self.pool.close().await;
    }
    pub async fn setup(&self, username: &str, password_hash: &str) -> Result<ConversationId> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM owners")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if exists != 0 {
            return Err(StoreError::AlreadySetup);
        }
        let owner = Uuid::new_v4().to_string();
        let conversation = ConversationId(Uuid::new_v4());
        sqlx::query("INSERT INTO owners(id,username,password_hash) VALUES (?,?,?)")
            .bind(&owner)
            .bind(username)
            .bind(password_hash)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO conversations(id,owner_id) VALUES (?,?)")
            .bind(conversation.to_string())
            .bind(owner)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(conversation)
    }
    pub async fn credentials(&self, username: &str) -> Result<Option<(OwnerId, String)>> {
        sqlx::query("SELECT id,password_hash FROM owners WHERE username=?")
            .bind(username)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .map(|r| Ok((OwnerId(parse(r.get(0))?), r.get(1))))
            .transpose()
    }
    pub async fn global(&self, owner: &OwnerId) -> Result<ConversationId> {
        let id = sqlx::query_scalar(
            "SELECT id FROM conversations WHERE owner_id=? AND project_id IS NULL",
        )
        .bind(owner.to_string())
        .fetch_one(&self.pool)
        .await
        .map_err(db)?;
        Ok(ConversationId(parse(id)?))
    }
    pub async fn save_session(&self, token: &str, owner: &OwnerId) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        sqlx::query("DELETE FROM auth_sessions WHERE expires_at <= unixepoch()")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,expires_at) VALUES (?,?,unixepoch()+43200)")
            .bind(digest(token)).bind(owner.to_string()).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(())
    }
    /// Revoke one exact hashed session; browser and machine tokens use distinct inputs.
    pub async fn revoke_session(&self, token: &str) -> Result<()> {
        sqlx::query("DELETE FROM auth_sessions WHERE token_hash=?")
            .bind(digest(token))
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }
    pub async fn authenticate(&self, token: &str) -> Result<Option<OwnerId>> {
        let id: Option<String> = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(digest(token))
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?;
        id.map(|s| parse(s).map(OwnerId)).transpose()
    }
}
