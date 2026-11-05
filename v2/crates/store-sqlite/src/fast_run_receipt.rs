//! Read-only exact-input Fast proof; never selects a later run or a Deep result.
use super::*;

impl Store {
    pub async fn fast_run_receipt(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        query: &FastRunReceiptQuery,
    ) -> Result<FastRunReceipt> {
        if query.input_message_id.0.is_nil() || query.input_event_id.0.is_nil() {
            return Err(StoreError::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let authenticated: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(digest(credential)).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if authenticated != 1 {
            return Err(StoreError::NotFound);
        }
        let rows = sqlx::query("SELECT r.id,r.session_id,r.native_session_id,r.provider_kind,r.binding_generation,r.context_id,r.incarnation_id,r.state,r.dispatch_state,w.id AS window_id,w.generation AS window_generation,a.event_id AS acceptance_event_id FROM production_runs r JOIN execution_windows w ON w.owner_id=r.owner_id AND w.conversation_id=r.conversation_id AND w.context_id=r.context_id AND w.incarnation_id=r.incarnation_id JOIN execution_window_inputs i ON i.window_id=w.id AND i.message_id=r.message_id AND i.event_id=r.event_id LEFT JOIN production_acceptances a ON a.run_id=r.id WHERE r.owner_id=? AND r.conversation_id=? AND r.role='fast' AND r.message_id=? AND r.event_id=? LIMIT 2")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(query.input_message_id.to_string())
            .bind(query.input_event_id.to_string()).fetch_all(&mut *tx).await.map_err(db)?;
        if rows.is_empty() {
            return Err(StoreError::NotFound);
        }
        if rows.len() != 1 {
            return Err(StoreError::Conflict);
        }
        let row = &rows[0];
        let proof = FastRunReceipt {
            schema_version: 1,
            owner_id: owner.clone(),
            conversation_id: conversation.clone(),
            input_message_id: query.input_message_id.clone(),
            input_event_id: query.input_event_id.clone(),
            run_id: RunId(parse(row.get("id"))?),
            session_id: SessionId(parse(row.get("session_id"))?),
            native_session_id: row.get("native_session_id"),
            provider: crate::source_receipts::provider(row.get("provider_kind"))?,
            binding_generation: row.get("binding_generation"),
            context_id: row.get("context_id"),
            incarnation_id: row.get("incarnation_id"),
            window_id: parse(row.get("window_id"))?,
            window_generation: row.get("window_generation"),
            state: row.get("state"),
            dispatch_state: row.get("dispatch_state"),
            acceptance_event_id: row
                .get::<Option<String>, _>("acceptance_event_id")
                .map(parse)
                .transpose()?
                .map(EventId),
        };
        tx.commit().await.map_err(db)?;
        Ok(proof)
    }
}
