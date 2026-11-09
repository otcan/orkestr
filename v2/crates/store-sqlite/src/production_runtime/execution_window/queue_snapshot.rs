//! Queue reads shared by single routes and the owner status snapshot.
use super::*;
use orkestr_v2_contracts::{ExecutionWindowQueued, MAX_QUEUED_WINDOW_REQUESTS};

impl Store {
    pub(super) async fn queue_entries_snapshot(
        &self,
        tx: &mut SqliteConnection,
        owner: &OwnerId,
        conversation: Option<&ConversationId>,
    ) -> Result<Vec<ExecutionWindowQueued>> {
        #[cfg(test)]
        if conversation.is_none() {
            self.status_read_counts()
                .global_queue
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        let rows = sqlx::query("SELECT * FROM execution_window_queue WHERE owner_id=? AND state='queued' AND (? IS NULL OR conversation_id=?) ORDER BY position LIMIT ?")
            .bind(owner.to_string())
            .bind(conversation.map(|c| c.to_string())).bind(conversation.map(|c| c.to_string()))
            .bind(i64::from(MAX_QUEUED_WINDOW_REQUESTS))
            .fetch_all(&mut *tx).await.map_err(db)?;
        let mut result = Vec::with_capacity(rows.len());
        for row in &rows {
            result.push(super::queue::queued(tx, row).await?);
        }
        Ok(result)
    }

    pub(super) async fn live_windows_snapshot(
        &self,
        tx: &mut SqliteConnection,
        owner: &OwnerId,
    ) -> Result<u32> {
        #[cfg(test)]
        self.status_read_counts()
            .global_live
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let clock = now(&mut *tx).await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_windows WHERE owner_id=? AND state IN ('opening','active','retiring') AND expires_at_ms>?")
            .bind(owner.to_string()).bind(clock).fetch_one(&mut *tx).await.map_err(db)?;
        u32::try_from(count).map_err(db)
    }
}
