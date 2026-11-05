//! Read-only proof for settling a fenced request without releasing an orphan.
use super::*;
impl Store {
    /// A stale window tuple alone cannot release its still-queued source input.
    /// Only exact immutable Core retirement plus no admission/execution proves
    /// that later inputs cannot execute the refused original accidentally.
    pub async fn execution_window_input_retired_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<bool> {
        if !input.is_valid() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let count:i64=sqlx::query_scalar("SELECT count(*) FROM messages m JOIN events e ON e.message_id=m.id JOIN reasoning_inbox i ON i.message_id=m.id AND i.event_id=e.id JOIN owner_input_retirements r ON r.message_id=m.id AND r.event_id=e.id AND r.owner_id=m.owner_id AND r.conversation_id=m.conversation_id WHERE m.id=?1 AND e.id=?2 AND m.owner_id=?3 AND m.conversation_id=?4 AND e.owner_id=m.owner_id AND e.conversation_id=m.conversation_id AND i.conversation_id=m.conversation_id AND m.actor_kind='owner' AND m.request_key=?5 AND i.state='retired' AND i.claimant_session_id IS NULL AND i.admitted_run_id IS NULL AND i.admitted_fixture_run_id IS NULL AND NOT EXISTS(SELECT 1 FROM production_runs WHERE event_id=e.id OR message_id=m.id) AND NOT EXISTS(SELECT 1 FROM fixture_runs WHERE event_id=e.id OR message_id=m.id) AND NOT EXISTS(SELECT 1 FROM execution_window_inputs WHERE event_id=e.id OR message_id=m.id) AND NOT EXISTS(SELECT 1 FROM execution_window_queue WHERE (event_id=e.id OR message_id=m.id) AND state NOT IN ('withdrawn'))")
            .bind(input.input_message_id.to_string()).bind(input.input_event_id.to_string())
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&input.input_request_key)
            .fetch_one(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(count == 1)
    }
}
