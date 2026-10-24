//! Ten-minute owner-scoped metadata discovery replay, never mail authority.
use super::*;
use orkestr_v2_contracts::tracker_actions::{TrackerMailSource, TrackerSourceDiscovery};

async fn prior(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    key: &str,
) -> Result<Option<TrackerSourceDiscovery>> {
    let row:Option<String>=sqlx::query_scalar("SELECT receipt_json FROM tracker_discovery_receipts WHERE owner_id=? AND conversation_id=? AND request_key=? AND expires_ms>?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(key).bind(store_clock(tx).await?)
        .fetch_optional(&mut **tx).await.map_err(unavailable)?;
    row.map(|s| {
        let mut r: TrackerSourceDiscovery = serde_json::from_str(&s).map_err(unavailable)?;
        r.duplicate = true;
        Ok(r)
    })
    .transpose()
}
impl Store {
    pub async fn tracker_source_discovery(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        key: &str,
    ) -> Result<TrackerSourceDiscovery> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        if !valid(key, 128) {
            return Err(HistoryError::Invalid);
        }
        let result = prior(&mut tx, owner, conversation, key)
            .await?
            .ok_or(HistoryError::NotFound)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
    pub async fn record_tracker_source_discovery(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        key: &str,
        sources: &[TrackerMailSource],
        backing: &[TrackerLocalSource],
    ) -> Result<TrackerSourceDiscovery> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        target(&mut tx, owner, conversation).await?;
        if !valid(key, 128) {
            return Err(HistoryError::Invalid);
        }
        if let Some(old) = prior(&mut tx, owner, conversation, key).await? {
            tx.commit().await.map_err(unavailable)?;
            return Ok(old);
        }
        if sources.len() > 16
            || sources.len() != backing.len()
            || sources
                .iter()
                .any(|s| !backing.iter().any(|b| b.source_id == s.id))
        {
            return Err(HistoryError::Invalid);
        }
        let now = store_clock(&mut tx).await?;
        // Bound global cleanup so an inactive owner's expired metadata can be
        // collected by later discovery without an independent scheduler.
        sqlx::query("DELETE FROM tracker_discovery_receipts WHERE rowid IN(SELECT rowid FROM tracker_discovery_receipts WHERE expires_ms<=? ORDER BY expires_ms LIMIT 64)")
            .bind(now).execute(&mut *tx).await.map_err(unavailable)?;
        sqlx::query("DELETE FROM tracker_discovery_receipts WHERE owner_id=? AND expires_ms<=?")
            .bind(owner.to_string())
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM tracker_discovery_receipts WHERE owner_id=?")
                .bind(owner.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
        if count >= 64 {
            return Err(HistoryError::Conflict);
        }
        let expires = local_sources::register(&mut tx, owner, backing).await?;
        let result = TrackerSourceDiscovery {
            request_key: key.into(),
            sources: sources.to_vec(),
            expires_ms: expires,
            read_only: true,
            duplicate: false,
        };
        let json = serde_json::to_string(&result).map_err(unavailable)?;
        if json.len() > 64_000 {
            return Err(HistoryError::Invalid);
        }
        sqlx::query("INSERT INTO tracker_discovery_receipts(owner_id,conversation_id,request_key,receipt_json,expires_ms) VALUES(?,?,?,?,?)")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(key).bind(json).bind(expires).execute(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}
