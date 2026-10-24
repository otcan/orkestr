//! Trusted local registry persistence, separate from owner source decisions.
use super::*;

impl Store {
    /// Private readiness material for an already selected source. Discovery
    /// expiry revokes new choices, not the owner's durable current selection.
    pub async fn tracker_selected_source_backing(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        expected_revision: i64,
    ) -> Result<(SelectedMailSource, String)> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        let old = sqlx::query("SELECT t.source_json,r.backing_json FROM trackers t JOIN tracker_source_selections s ON s.owner_id=t.owner_id AND s.conversation_id=t.conversation_id AND s.source_revision=t.source_revision AND s.selection_json=t.source_json AND s.acknowledged=1 JOIN tracker_local_sources r ON r.owner_id=t.owner_id AND r.source_id=json_extract(t.source_json,'$.source_id') WHERE t.owner_id=? AND t.conversation_id=? AND t.source_revision=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(expected_revision).fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or(HistoryError::Conflict)?;
        let source: SelectedMailSource =
            serde_json::from_str(old.get("source_json")).map_err(unavailable)?;
        if !source.is_valid() {
            return Err(HistoryError::Conflict);
        }
        let result = (source, old.get("backing_json"));
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
    pub async fn tracker_scan_namespaces(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<Vec<Uuid>> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        let rows: Vec<String> = sqlx::query_scalar("SELECT DISTINCT a.namespace FROM tracker_scan_authorities a JOIN dormant_timers t ON t.owner_id=a.owner_id AND t.namespace=a.namespace AND t.generation=a.generation WHERE a.owner_id=? AND a.conversation_id=? AND t.state='enabled' ORDER BY a.namespace LIMIT 256")
            .bind(owner.to_string()).bind(conversation.to_string()).fetch_all(&mut *tx).await.map_err(unavailable)?;
        let result = rows
            .iter()
            .map(|id| Uuid::parse_str(id).map_err(unavailable))
            .collect::<Result<_>>()?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
    /// Explicit owner discovery only. Backing data comes from the local reader,
    /// never a decoded browser body. This method neither selects nor reads mail.
    pub async fn register_tracker_local_sources(
        &self,
        credential: &str,
        owner: &OwnerId,
        sources: &[TrackerLocalSource],
    ) -> Result<i64> {
        if sources.len() > 16
            || sources.iter().any(|s| {
                s.source_id.is_nil()
                    || s.backing_json.len() > 64_000
                    || serde_json::from_str::<serde_json::Value>(&s.backing_json).is_err()
            })
        {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let now = store_clock(&mut tx).await?;
        let expires = now
            .checked_add(10 * 60_000)
            .ok_or(HistoryError::Unavailable)?;
        sqlx::query("DELETE FROM tracker_local_sources WHERE owner_id=? AND expires_ms<=? AND source_id NOT IN(SELECT json_extract(source_json,'$.source_id') FROM trackers WHERE owner_id=? AND source_json IS NOT NULL AND json_extract(source_json,'$.source_id') IS NOT NULL)")
            .bind(owner.to_string()).bind(now).bind(owner.to_string()).execute(&mut *tx).await.map_err(unavailable)?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM tracker_local_sources WHERE owner_id=?")
                .bind(owner.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
        if count + sources.len() as i64 > 256 {
            return Err(HistoryError::Conflict);
        }
        for source in sources {
            sqlx::query("INSERT INTO tracker_local_sources(owner_id,source_id,backing_json,expires_ms) VALUES(?,?,?,?)")
                .bind(owner.to_string()).bind(source.source_id.to_string()).bind(&source.backing_json).bind(expires)
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(expires)
    }

    /// New selections require a fresh discovery. Exact prior decision receipt
    /// lookup must precede this call in the HTTP layer.
    pub async fn tracker_local_source_for_selection(
        &self,
        credential: &str,
        owner: &OwnerId,
        source: Uuid,
    ) -> Result<String> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        let now = store_clock(&mut tx).await?;
        let backing: String = sqlx::query_scalar("SELECT backing_json FROM tracker_local_sources WHERE owner_id=? AND source_id=? AND expires_ms>?")
            .bind(owner.to_string()).bind(source.to_string()).bind(now)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or(HistoryError::Conflict)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(backing)
    }

    /// A read-only target lookup lets the runtime reserve custody BEFORE claim.
    pub async fn tracker_scan_target(
        &self,
        issuer: &crate::TimerSchedulerIssuer,
        namespace: Uuid,
    ) -> Result<(OwnerId, ConversationId)> {
        let (mut tx, owner) = self.timer_scheduler_transaction(issuer, namespace).await?;
        let now = store_clock(&mut tx).await?;
        let current = view::current(&mut tx, &owner, namespace, now).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok((owner, current.conversation))
    }

    /// Private resolver material for this current claim only. Selected references
    /// remain durable after discovery expiry; each reader rechecks file identity.
    pub async fn tracker_scan_material(
        &self,
        issuer: &crate::TimerSchedulerIssuer,
        claim: &TrackerScanClaim,
    ) -> Result<(String, Option<String>)> {
        let (mut tx, owner) = self
            .timer_scheduler_transaction(issuer, claim.namespace)
            .await?;
        if owner != claim.owner || issuer.tracker_scan_key() != claim.issuer_key {
            return Err(HistoryError::Unauthorized);
        }
        let now = store_clock(&mut tx).await?;
        let current = view::current(&mut tx, &owner, claim.namespace, now).await?;
        if now >= claim.deadline_ms
            || current.authority_id != claim.authority_id
            || current.source_revision != claim.source_revision
            || current.source != claim.source
        {
            return Err(HistoryError::Conflict);
        }
        let backing: String = sqlx::query_scalar(
            "SELECT backing_json FROM tracker_local_sources WHERE owner_id=? AND source_id=?",
        )
        .bind(owner.to_string())
        .bind(claim.source.source_id.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?
        .ok_or(HistoryError::Conflict)?;
        let cursor: Option<String> = sqlx::query_scalar(
            "SELECT cursor_json FROM trackers WHERE owner_id=? AND conversation_id=?",
        )
        .bind(owner.to_string())
        .bind(claim.conversation.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok((backing, cursor))
    }
}
