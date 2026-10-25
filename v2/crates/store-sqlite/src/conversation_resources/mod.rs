//! Owner-scoped conversation resources: settings, brokered V1 desktop leases
//! and V1 worker links. None of these rows admit input, start execution or
//! create effects; they are preferences, fences and lineage.
mod desktops;
pub(crate) mod fast_settings;
mod legacy_workers;
pub(crate) mod settings;
#[cfg(test)]
mod tests_desktops;
#[cfg(test)]
mod tests_fast_settings;
#[cfg(test)]
pub(crate) mod tests_settings;
#[cfg(test)]
mod tests_workers;

pub use desktops::{DesktopCaller, DesktopFence, PreparedAcquire, V1LeaseGrant};

use crate::Store;
use orkestr_v2_contracts::{ConversationId, OwnerId};
use sqlx::{Sqlite, Transaction};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceError {
    Invalid,
    Unauthorized,
    NotFound,
    /// Stable machine code for the refused precondition.
    Conflict(&'static str),
    Unavailable,
}
pub(crate) type Result<T> = std::result::Result<T, ResourceError>;
pub(crate) fn unavailable(_: impl std::fmt::Display) -> ResourceError {
    ResourceError::Unavailable
}
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Store {
    /// Exact owner credential plus conversation ownership, inside one transaction.
    pub(crate) async fn owner_scope(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        write: bool,
    ) -> Result<Transaction<'_, Sqlite>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(ResourceError::Unauthorized);
        }
        if conversation.0.is_nil() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .pool
            .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
            .await
            .map_err(unavailable)?;
        let sessions: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .bind(owner.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if sessions != 1 {
            return Err(ResourceError::Unauthorized);
        }
        owned(&mut tx, owner, conversation).await?;
        Ok(tx)
    }
}

pub(crate) async fn owned(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<()> {
    let owned: i64 =
        sqlx::query_scalar("SELECT count(*) FROM conversations WHERE id=? AND owner_id=?")
            .bind(conversation.to_string())
            .bind(owner.to_string())
            .fetch_one(&mut **tx)
            .await
            .map_err(unavailable)?;
    if owned == 1 {
        Ok(())
    } else {
        Err(ResourceError::NotFound)
    }
}
