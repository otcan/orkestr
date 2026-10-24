//! Exact, revision-checked revocation; an old retry cannot clear a newer source.
use super::*;

impl Store {
    pub async fn remove_tracker_scan_source(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &TrackerSourceRemove,
    ) -> Result<TrackerSourceReceipt> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        target(&mut tx, owner, conversation).await?;
        let digest = hash("orkestr.tracker.source.v1:null");
        if let Some(old) = sqlx::query("SELECT expected_revision,source_revision,source_digest,acknowledged FROM tracker_source_selections WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?
        {
            if old.get::<i64,_>("expected_revision") != request.expected_revision
                || old.get::<String,_>("source_digest") != digest
                || old.get::<i64,_>("acknowledged") != 0 { return Err(HistoryError::Conflict); }
            let receipt = TrackerSourceReceipt { request_key: request.request_key.clone(), source_revision: old.get("source_revision"), source_digest: digest, duplicate: true };
            tx.commit().await.map_err(unavailable)?;
            return Ok(receipt);
        }
        if !valid(&request.request_key, 128) || request.expected_revision < 0 {
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
        let revision = revision(request.expected_revision)?;
        let now = store_clock(&mut tx).await?;
        sqlx::query("INSERT INTO tracker_source_selections(owner_id,conversation_id,source_revision,request_key,expected_revision,source_digest,selection_json,acknowledged,created_ms) VALUES(?,?,?,?,?,?,NULL,0,?)")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(revision).bind(&request.request_key)
            .bind(request.expected_revision).bind(&digest).bind(now).execute(&mut *tx).await.map_err(unavailable)?;
        source::quarantine(&mut tx, owner, conversation).await?;
        sqlx::query("UPDATE trackers SET source_json=NULL,source_revision=?,cursor_json=NULL,updated_ms=? WHERE owner_id=? AND conversation_id=?")
            .bind(revision).bind(now).bind(owner.to_string()).bind(conversation.to_string())
            .execute(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(TrackerSourceReceipt {
            request_key: request.request_key.clone(),
            source_revision: revision,
            source_digest: digest,
            duplicate: false,
        })
    }
}
