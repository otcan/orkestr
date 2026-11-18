//! Owner-authenticated read of every Deep progress payload of a conversation
//! in event order (the web chat shows each one as its own update). Read-only;
//! driven by the conversation's event index, so a page costs one range scan.
use super::*;
use orkestr_v2_contracts::{
    ConversationId, PayloadId, RunId, RunUpdate, RunUpdates, RUN_UPDATES_PAGE_MAX,
};

/// Progress payloads of Deep runs. `final` marks the payload an accepted
/// result names: the last progress before the run's accepted completion
/// (the same rule as `accepted_results::ACCEPTED`).
const UPDATES: &str = "SELECT o.run_id,p.id AS payload_id,e.sequence,CAST((julianday(e.occurred_at)-2440587.5)*86400000 AS INTEGER) AS observed_ms,p.text IS NULL AS removed,EXISTS(SELECT 1 FROM production_acceptances a JOIN production_observations c ON c.event_id=a.completion_event_id AND c.run_id=a.run_id AND c.kind='completed_proposal' AND c.receipt_state='awaiting_acceptance' WHERE a.run_id=o.run_id AND a.owner_id=e.owner_id AND a.conversation_id=e.conversation_id AND c.run_sequence>o.run_sequence AND NOT EXISTS(SELECT 1 FROM production_observations n JOIN production_payloads np ON np.event_id=n.event_id WHERE n.run_id=o.run_id AND n.kind='progress' AND n.run_sequence>o.run_sequence AND n.run_sequence<c.run_sequence)) AS is_final FROM events e JOIN production_observations o ON o.event_id=e.id AND o.kind='progress' JOIN production_payloads p ON p.event_id=o.event_id AND p.run_id=o.run_id AND p.owner_id=e.owner_id AND p.conversation_id=e.conversation_id JOIN production_runs r ON r.id=o.run_id AND r.owner_id=e.owner_id AND r.conversation_id=e.conversation_id AND r.role='deep' WHERE e.owner_id=? AND e.conversation_id=? AND e.kind='provider_observed'";

#[derive(Clone, Copy)]
enum Cursor {
    After(i64),
    Before(i64),
}

impl Store {
    /// The oldest `limit` updates after `after_sequence`, oldest first.
    pub async fn run_updates_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        after_sequence: i64,
        limit: u16,
    ) -> Result<RunUpdates> {
        self.run_updates_page(
            credential,
            conversation,
            Cursor::After(after_sequence),
            limit,
        )
        .await
    }

    /// The newest `limit` updates below `before_sequence`, oldest first
    /// (`i64::MAX`: the newest page). No forward cursor; a full page means
    /// older updates may exist below its first row.
    pub async fn run_updates_before_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        before_sequence: i64,
        limit: u16,
    ) -> Result<RunUpdates> {
        self.run_updates_page(
            credential,
            conversation,
            Cursor::Before(before_sequence),
            limit,
        )
        .await
    }

    async fn run_updates_page(
        &self,
        credential: &str,
        conversation: &ConversationId,
        cursor: Cursor,
        limit: u16,
    ) -> Result<RunUpdates> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let (bound, order, value, valid) = match cursor {
            Cursor::After(after) => ("e.sequence>?", "", after, after >= 0),
            Cursor::Before(before) => ("e.sequence<?", " DESC", before, before >= 1),
        };
        if conversation.0.is_nil() || !valid || !(1..=RUN_UPDATES_PAGE_MAX).contains(&limit) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner: String = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Unauthorized)?;
        let owner = OwnerId(owner.parse().map_err(db)?);
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let sql = format!("{UPDATES} AND {bound} ORDER BY e.sequence{order} LIMIT ?");
        let mut rows = sqlx::query(&sql)
            .bind(owner.to_string())
            .bind(conversation.to_string())
            .bind(value)
            .bind(i64::from(limit) + 1)
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;
        let more = rows.len() > usize::from(limit);
        rows.truncate(usize::from(limit));
        if matches!(cursor, Cursor::Before(_)) {
            rows.reverse();
        }
        let mut updates = Vec::with_capacity(rows.len());
        for row in rows {
            updates.push(RunUpdate {
                run_id: RunId(row.get::<String, _>("run_id").parse().map_err(db)?),
                payload_id: PayloadId(row.get::<String, _>("payload_id").parse().map_err(db)?),
                sequence: row.get("sequence"),
                observed_at_ms: row.get::<Option<i64>, _>("observed_ms").unwrap_or(0).max(0),
                payload_removed: row.get::<i64, _>("removed") != 0,
                final_answer: row.get::<i64, _>("is_final") != 0,
            });
        }
        let next_after_sequence = (more && matches!(cursor, Cursor::After(_)))
            .then(|| updates.last().expect("nonempty bounded page").sequence);
        let result = RunUpdates {
            conversation_id: conversation.clone(),
            updates,
            next_after_sequence,
        };
        if !result.is_valid() {
            return Err(RuntimeStoreError::Unavailable);
        }
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}
