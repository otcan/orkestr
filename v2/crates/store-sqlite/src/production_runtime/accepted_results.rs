//! Owner-authenticated read projection, independent of any supervisor lifetime.
use super::*;
use orkestr_v2_contracts::{
    AcceptedResult, AcceptedResults, ConversationId, EventId, PayloadId, RunId,
};
impl Store {
    pub async fn accepted_results_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        after_sequence: i64,
        limit: u16,
    ) -> Result<AcceptedResults> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if conversation.0.is_nil() || after_sequence < 0 || !(1..=50).contains(&limit) {
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
        let rows = sqlx::query("SELECT a.run_id,a.completion_event_id,a.event_id,e.sequence,p.id AS payload_id,p.text IS NULL AS removed,EXISTS(SELECT 1 FROM production_auto_acceptances auto WHERE auto.run_id=a.run_id) AS auto FROM production_acceptances a JOIN events e ON e.id=a.event_id AND e.owner_id=a.owner_id AND e.conversation_id=a.conversation_id AND e.kind='execution_accepted' AND e.schema_version=9 JOIN production_runs r ON r.id=a.run_id AND r.owner_id=a.owner_id AND r.conversation_id=a.conversation_id JOIN production_observations o ON o.event_id=a.completion_event_id AND o.run_id=r.id AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance' JOIN events completion ON completion.id=o.event_id AND completion.owner_id=a.owner_id AND completion.conversation_id=a.conversation_id AND completion.kind='provider_observed' LEFT JOIN production_payloads p ON p.id=(SELECT payload.id FROM production_payloads payload JOIN production_observations progress ON progress.event_id=payload.event_id AND progress.run_id=r.id AND progress.kind='progress' WHERE payload.run_id=r.id AND payload.owner_id=a.owner_id AND payload.conversation_id=a.conversation_id AND progress.run_sequence<o.run_sequence ORDER BY progress.run_sequence DESC LIMIT 1) WHERE a.owner_id=? AND a.conversation_id=? AND e.sequence>? ORDER BY e.sequence LIMIT ?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(after_sequence)
            .bind(i64::from(limit)+1).fetch_all(&mut *tx).await.map_err(db)?;
        let more = rows.len() > usize::from(limit);
        let mut results = Vec::new();
        for row in rows.into_iter().take(usize::from(limit)) {
            let payload: Option<String> = row.get("payload_id");
            results.push(AcceptedResult {
                run_id: RunId(row.get::<String, _>("run_id").parse().map_err(db)?),
                completion_event_id: EventId(
                    row.get::<String, _>("completion_event_id")
                        .parse()
                        .map_err(db)?,
                ),
                acceptance_event_id: EventId(row.get::<String, _>("event_id").parse().map_err(db)?),
                acceptance_sequence: row.get("sequence"),
                payload_removed: payload.is_some() && row.get::<i64, _>("removed") != 0,
                auto_accepted: row.get::<i64, _>("auto") != 0,
                payload_id: payload
                    .map(|p| p.parse().map(PayloadId).map_err(db))
                    .transpose()?,
            });
        }
        let next_after_sequence = more.then(|| {
            results
                .last()
                .expect("nonempty bounded page")
                .acceptance_sequence
        });
        let result = AcceptedResults {
            conversation_id: conversation.clone(),
            results,
            next_after_sequence,
        };
        if !result.is_valid() {
            return Err(RuntimeStoreError::Unavailable);
        }
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}
