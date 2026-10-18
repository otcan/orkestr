//! Authenticated, inert history ledger. Never admits native conversation input.
mod auth;
mod fingerprint;
mod readback;
#[cfg(test)]
mod recovery_tests;
mod rollback;
#[cfg(test)]
mod tests;

use crate::Store;
pub use fingerprint::history_source_digest;
use orkestr_v2_contracts::*;
use sqlx::{Row, Sqlite, Transaction};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryError {
    Invalid,
    Unauthorized,
    NotFound,
    Conflict,
    Unavailable,
}
pub type Result<T> = std::result::Result<T, HistoryError>;
fn unavailable(_: impl std::fmt::Display) -> HistoryError {
    HistoryError::Unavailable
}

impl Store {
    async fn history_transaction(
        &self,
        credential: &str,
        owner: &OwnerId,
        write: bool,
    ) -> Result<Transaction<'_, Sqlite>> {
        if self.authority.is_some() {
            return Err(HistoryError::Unauthorized);
        }
        let mut tx = self
            .pool
            .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
            .await
            .map_err(unavailable)?;
        if !auth::authorized(&mut tx, credential, owner)
            .await
            .map_err(unavailable)?
        {
            return Err(HistoryError::Unauthorized);
        }
        Ok(tx)
    }

    pub async fn import_history(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &HistoryImportRequest,
    ) -> Result<HistoryImportReceipt> {
        let bytes = fingerprint::canonical(request)?;
        if history_source_digest(request)? != request.source_digest {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let exists: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM history_imports WHERE owner_id=? AND namespace=?",
        )
        .bind(owner.to_string())
        .bind(request.namespace.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        let receipt = if exists == 1 {
            let (stored, mut receipt) =
                readback::verified(&mut tx, owner, request.namespace).await?;
            if fingerprint::canonical(&stored).map_err(|_| HistoryError::Conflict)? != bytes {
                return Err(HistoryError::Conflict);
            }
            receipt.revision = 1;
            receipt.active = true;
            receipt
        } else {
            sqlx::query("INSERT INTO history_imports(owner_id,namespace,source_digest,source_conversation_id,source_scope,source_watermark,message_count) VALUES(?,?,?,?,?,?,?)")
                .bind(owner.to_string()).bind(request.namespace.to_string()).bind(&request.source_digest)
                .bind(request.source_conversation_id.to_string()).bind(fingerprint::scope_text(&request.source_scope))
                .bind(request.source_watermark).bind(request.messages.len() as i64)
                .execute(&mut *tx).await.map_err(unavailable)?;
            for (ordinal, message) in request.messages.iter().enumerate() {
                sqlx::query("INSERT INTO history_messages(owner_id,namespace,ordinal,source_message_id,source_sequence,actor_kind,text) VALUES(?,?,?,?,?,?,?)")
                    .bind(owner.to_string()).bind(request.namespace.to_string()).bind(ordinal as i64)
                    .bind(message.message_id.to_string()).bind(message.sequence).bind(&message.actor_kind).bind(&message.text)
                    .execute(&mut *tx).await.map_err(unavailable)?;
            }
            readback::verified(&mut tx, owner, request.namespace)
                .await?
                .1
        };
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("history-import-before-commit")
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("history-import-after-commit")
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        Ok(receipt)
    }
}
