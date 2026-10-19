//! Default-off, explicit browser-owner consent; no provider or effect authority.
mod read;
#[cfg(test)]
mod tests;
mod validation;
mod write;
use crate::Store;
use orkestr_v2_contracts::*;
use sqlx::{Row, Sqlite, Transaction};
use uuid::Uuid;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryError {
    Invalid,
    Unauthorized,
    Disabled,
    NotFound,
    Conflict,
    Limit,
    Unavailable,
}
pub type Result<T> = std::result::Result<T, MemoryError>;
fn db(_: impl std::fmt::Display) -> MemoryError {
    MemoryError::Unavailable
}
impl Store {
    async fn memory_transaction(
        &self,
        credential: &str,
        write: bool,
        require_enabled: bool,
    ) -> Result<(Transaction<'_, Sqlite>, OwnerId)> {
        // Same closed namespace as ordinary browser sessions. Bare machine
        // credentials and any supervisor-bound Store cannot consent.
        let token = credential
            .strip_prefix("browser:")
            .ok_or(MemoryError::Unauthorized)?;
        if self.authority.is_some()
            || token.len() != 64
            || !token.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(MemoryError::Unauthorized);
        }
        let mut tx = self
            .pool
            .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
            .await
            .map_err(db)?;
        let owner: String = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(MemoryError::Unauthorized)?;
        let owner = OwnerId(owner.parse().map_err(db)?);
        if require_enabled {
            let enabled: Option<i64> =
                sqlx::query_scalar("SELECT enabled FROM memory_settings WHERE owner_id=?")
                    .bind(owner.to_string())
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(db)?;
            if enabled != Some(1) {
                return Err(MemoryError::Disabled);
            }
        }
        Ok((tx, owner))
    }
    /// Trusted explicit owner control call; no route is activated by this port.
    pub async fn set_memory_enabled_authenticated(
        &self,
        credential: &str,
        enabled: bool,
    ) -> Result<()> {
        let (mut tx, owner) = self.memory_transaction(credential, true, false).await?;
        sqlx::query("INSERT INTO memory_settings(owner_id,enabled) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled")
            .bind(owner.to_string()).bind(enabled as i64).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)
    }
    /// Transient proposal. No candidate or consent is persisted here.
    pub async fn propose_memory_authenticated(
        &self,
        credential: &str,
        request_key: &str,
        mut operation: MemoryOperation,
    ) -> Result<MemoryProposal> {
        let (mut tx, owner) = self.memory_transaction(credential, false, true).await?;
        validation::normalize(&mut operation)?;
        validation::validate_operation(&mut tx, &owner, &operation).await?;
        if !validation::key(request_key, 128) {
            return Err(MemoryError::Invalid);
        }
        let digest = validation::proposal_digest(request_key, &operation)?;
        tx.commit().await.map_err(db)?;
        Ok(MemoryProposal {
            schema_version: 1,
            request_key: request_key.into(),
            operation,
            digest,
        })
    }
}

#[cfg(test)]
mod read_tests;

#[cfg(test)]
mod validation_tests;
