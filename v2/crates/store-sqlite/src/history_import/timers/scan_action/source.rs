//! Exact owner source decisions. Receipt recovery precedes current admission.
use super::*;

impl Store {
    /// The trusted HTTP layer resolves the expiring selection before this call.
    /// Only opaque registry IDs are retained; a grant cannot select a source.
    pub async fn select_tracker_scan_source(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &TrackerSourceSelect,
    ) -> Result<TrackerSourceReceipt> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        target(&mut tx, owner, conversation).await?;
        let digest = source_digest(&request.source)?;
        if let Some(old) = sqlx::query("SELECT expected_revision,source_digest,source_revision,acknowledged FROM tracker_source_selections WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?
        {
            if old.get::<i64,_>("expected_revision") != request.expected_revision
                || old.get::<String,_>("source_digest") != digest
                || (old.get::<i64,_>("acknowledged") != 0) != request.acknowledge_read_only_access
            {
                return Err(HistoryError::Conflict);
            }
            let result = TrackerSourceReceipt {
                request_key: request.request_key.clone(),
                source_revision: old.get("source_revision"),
                source_digest: digest,
                duplicate: true,
            };
            tx.commit().await.map_err(unavailable)?;
            return Ok(result);
        }
        if !valid(&request.request_key, 128)
            || request.expected_revision < 0
            || !request.source.is_valid()
            || !request.acknowledge_read_only_access
        {
            return Err(HistoryError::Invalid);
        }
        let before: Option<i64> = sqlx::query_scalar(
            "SELECT source_revision FROM trackers WHERE owner_id=? AND conversation_id=?",
        )
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if before != Some(request.expected_revision) {
            return Err(HistoryError::Conflict);
        }
        let revision = request
            .expected_revision
            .checked_add(1)
            .ok_or(HistoryError::Conflict)?;
        let source = serde_json::to_string(&request.source).map_err(unavailable)?;
        let now = store_clock(&mut tx).await?;
        sqlx::query("INSERT INTO tracker_source_selections(owner_id,conversation_id,source_revision,request_key,expected_revision,source_digest,selection_json,acknowledged,created_ms) VALUES(?,?,?,?,?,?,?,1,?)")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(revision)
            .bind(&request.request_key).bind(request.expected_revision).bind(&digest).bind(&source).bind(now)
            .execute(&mut *tx).await.map_err(unavailable)?;
        quarantine(&mut tx, owner, conversation).await?;
        sqlx::query("UPDATE trackers SET source_json=?,source_revision=?,cursor_json=NULL,updated_ms=? WHERE owner_id=? AND conversation_id=?")
            .bind(source).bind(revision).bind(now).bind(owner.to_string()).bind(conversation.to_string())
            .execute(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(TrackerSourceReceipt {
            request_key: request.request_key.clone(),
            source_revision: revision,
            source_digest: digest,
            duplicate: false,
        })
    }

    /// An interrupted decision can be read after a newer selection or Stop.
    /// Authentication is repeated; this lookup creates no replacement authority.
    pub async fn tracker_source_receipt(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        key: &str,
    ) -> Result<TrackerSourceReceipt> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        let row = sqlx::query("SELECT source_revision,source_digest FROM tracker_source_selections WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(key)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or(HistoryError::NotFound)?;
        let receipt = TrackerSourceReceipt {
            request_key: key.to_owned(),
            source_revision: row.get("source_revision"),
            source_digest: row.get("source_digest"),
            duplicate: true,
        };
        tx.commit().await.map_err(unavailable)?;
        Ok(receipt)
    }
}

pub(super) async fn quarantine(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<()> {
    // Source changes preserve prior evidence and revoke its pending intake.
    sqlx::query("UPDATE tracker_unresolved_events SET state='quarantined' WHERE owner_id=? AND conversation_id=? AND state='pending'")
        .bind(owner.to_string()).bind(conversation.to_string()).execute(&mut **tx).await.map_err(unavailable)?;
    sqlx::query("UPDATE tracker_ledger SET outcome='quarantined_source' WHERE owner_id=? AND conversation_id=? AND outcome='unresolved'")
        .bind(owner.to_string()).bind(conversation.to_string()).execute(&mut **tx).await.map_err(unavailable)?;
    Ok(())
}
