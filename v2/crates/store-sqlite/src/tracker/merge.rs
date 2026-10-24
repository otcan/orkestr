//! Logical row merges retain immutable event identities and exact replay receipts.
use super::{edit::one, Result};
use crate::conversation_resources::{now_ms, unavailable, ResourceError};
use crate::Store;
use orkestr_v2_contracts::*;
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

pub(super) async fn ensure_active(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    row: Uuid,
) -> Result<()> {
    let merged: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_row_merges WHERE owner_id=? AND conversation_id=? AND absorb_id=?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(row.to_string()).fetch_one(&mut **tx).await.map_err(unavailable)?;
    if merged != 0 {
        return Err(ResourceError::Conflict("tracker_row_merged"));
    }
    Ok(())
}

impl Store {
    /// Merge active rows once while retaining every original event and row.
    pub async fn merge_tracker_rows(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        merge: &TrackerMerge,
    ) -> Result<TrackerRow> {
        if merge.keep == merge.absorb || merge.keep.is_nil() || merge.absorb.is_nil() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        super::config(&mut tx, owner, conversation).await?;
        let previous: Option<(String, String)> = sqlx::query_as("SELECT keep_id,receipt_json FROM tracker_row_merges WHERE owner_id=? AND conversation_id=? AND absorb_id=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(merge.absorb.to_string())
            .fetch_optional(&mut *tx).await.map_err(unavailable)?;
        if let Some((keep, receipt)) = previous {
            if keep != merge.keep.to_string() {
                return Err(ResourceError::Conflict("tracker_row_already_merged"));
            }
            let receipt = serde_json::from_str(&receipt).map_err(unavailable)?;
            tx.commit().await.map_err(unavailable)?;
            return Ok(receipt);
        }
        ensure_active(&mut tx, owner, conversation, merge.keep).await?;
        ensure_active(&mut tx, owner, conversation, merge.absorb).await?;
        let mut keep = one(&mut tx, owner, conversation, merge.keep).await?;
        let absorb = one(&mut tx, owner, conversation, merge.absorb).await?;
        // Status event time, including explicit owner edits, decides the winner.
        // Equal times retain the requested keep row deterministically.
        if absorb.status_changed_ms > keep.status_changed_ms {
            keep.status = absorb.status;
            keep.status_changed_ms = absorb.status_changed_ms;
            keep.next_step = absorb.next_step.clone();
        }
        keep.applied_ms = match (keep.applied_ms, absorb.applied_ms) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        keep.last_contact_ms = keep.last_contact_ms.max(absorb.last_contact_ms);
        if keep.role.is_empty() {
            keep.role = absorb.role.clone();
            keep.role_key = absorb.role_key.clone();
        }
        keep.link = keep.link.or(absorb.link.clone());
        keep.location = keep.location.or(absorb.location.clone());
        if !absorb.notes.is_empty() {
            keep.notes = if keep.notes.is_empty() {
                absorb.notes.clone()
            } else {
                format!("{}\n{}", keep.notes, absorb.notes)
            }
            .chars()
            .take(TRACKER_NOTES_MAX)
            .collect();
        }
        keep.events_count += absorb.events_count;
        keep.revision += 1;
        let (o, c) = (owner.to_string(), conversation.to_string());
        for sql in [
            "UPDATE OR IGNORE tracker_row_links SET row_id=? WHERE row_id=? AND owner_id=? AND conversation_id=?",
            "UPDATE tracker_messages SET row_id=? WHERE row_id=? AND owner_id=? AND conversation_id=?",
        ] {
            sqlx::query(sql)
                .bind(keep.id.to_string()).bind(absorb.id.to_string()).bind(&o).bind(&c)
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        sqlx::query(
            "DELETE FROM tracker_row_links WHERE row_id=? AND owner_id=? AND conversation_id=?",
        )
        .bind(absorb.id.to_string())
        .bind(&o)
        .bind(&c)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
        sqlx::query("UPDATE tracker_rows SET archived=1,revision=revision+1 WHERE id=? AND owner_id=? AND conversation_id=?")
            .bind(absorb.id.to_string()).bind(&o).bind(&c)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        sqlx::query("UPDATE tracker_rows SET role=?,role_key=?,status=?,status_changed_ms=?,applied_ms=?,last_contact_ms=?,next_step=?,link=?,location=?,notes=?,events_count=?,revision=?,updated_ms=? WHERE id=? AND owner_id=? AND conversation_id=?")
            .bind(&keep.role).bind(&keep.role_key).bind(keep.status.as_str()).bind(keep.status_changed_ms)
            .bind(keep.applied_ms).bind(keep.last_contact_ms).bind(&keep.next_step).bind(&keep.link).bind(&keep.location)
            .bind(&keep.notes).bind(i64::from(keep.events_count)).bind(keep.revision).bind(now_ms())
            .bind(keep.id.to_string()).bind(&o).bind(&c)
            .execute(&mut *tx).await.map_err(unavailable)?;
        sqlx::query("INSERT INTO tracker_row_merges(owner_id,conversation_id,absorb_id,keep_id,recorded_ms,receipt_json) VALUES(?,?,?,?,?,?)")
            .bind(&o).bind(&c).bind(absorb.id.to_string()).bind(keep.id.to_string()).bind(now_ms())
            .bind(serde_json::to_string(&keep).map_err(unavailable)?)
            .execute(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(keep)
    }
}
