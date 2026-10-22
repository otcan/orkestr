//! Authenticated inert byte storage. Never creates native conversation input.
//!
//! Object bytes are stored as age ciphertext for the owner's active browser
//! recipients (see `keys`). Plaintext is stored only while the owner has no
//! active recipient and no fail-closed policy (fresh installs and tests).
pub mod keys;
mod list;
mod read;
pub use read::StoredObject;
#[cfg(test)]
mod encryption_tests;
pub mod seal;
#[cfg(test)]
mod seal_fixture;
#[cfg(test)]
mod tests;
mod write;
use crate::Store;
use orkestr_v2_contracts::*;
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentError {
    Invalid,
    Unauthorized,
    NotFound,
    Removed,
    Inert,
    Conflict,
    Unavailable,
    /// Encryption is required and the owner has no active recipient.
    EncryptionKeyRequired,
}
pub type Result<T> = std::result::Result<T, AttachmentError>;
fn db<T>(_: T) -> AttachmentError {
    AttachmentError::Unavailable
}
impl Store {
    async fn attachment_transaction(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        write: bool,
    ) -> Result<Transaction<'_, Sqlite>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(AttachmentError::Unauthorized);
        }
        let mut tx = self
            .pool
            .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
            .await
            .map_err(db)?;
        let auth:i64=sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(crate::digest(credential)).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if auth != 1 {
            return Err(AttachmentError::Unauthorized);
        }
        let scope: i64 =
            sqlx::query_scalar("SELECT count(*) FROM conversations WHERE id=? AND owner_id=?")
                .bind(conversation.to_string())
                .bind(owner.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if scope != 1 {
            return Err(AttachmentError::NotFound);
        }
        Ok(tx)
    }
}
fn key_valid(key: &str) -> bool {
    !key.is_empty() && key.len() <= 128 && !key.chars().any(char::is_control)
}

#[cfg(all(test, feature = "fixture-test-controls", unix))]
mod process_tests;
