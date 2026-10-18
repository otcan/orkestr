//! Authenticated read-only discovery; no native IDs, locators or lease tokens.
use super::*;
use orkestr_v2_contracts::{
    ConversationId, WorkerExecutionPage, WorkerExecutionSummary, WorkerRecoveryDisposition,
};
impl Store {
    pub async fn worker_executions_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        after: Option<&orkestr_v2_contracts::RunId>,
        limit: u32,
    ) -> Result<WorkerExecutionPage> {
        if credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if !(1..=100).contains(&limit) || after.is_some_and(|id| id.0.is_nil()) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let context = self.context()?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        let authorized: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(crate::digest(credential)).bind(context.owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if authorized != 1 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        context.authenticate(&mut tx).await?;
        context.validate(&mut tx).await?;
        crate::runtime::scope(&mut tx, &context.owner, conversation).await?;
        let revision =
            sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
                .bind(conversation.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        let clock = now(&mut tx).await?;
        let rows = sqlx::query("SELECT r.id,r.session_id,r.state,r.incarnation_id,r.message_id,r.event_id,d.parent_run_id,d.parent_session_id,c.revision FROM production_runs r JOIN worker_provider_delegations d ON d.id=r.worker_delegation_id JOIN production_control_revisions c ON c.run_id=r.id WHERE r.owner_id=? AND r.conversation_id=? AND r.context_id=? AND r.role='worker' AND r.id>? ORDER BY r.id LIMIT ?")
            .bind(context.owner.to_string()).bind(conversation.to_string()).bind(&context.id)
            .bind(after.map(ToString::to_string).unwrap_or_default()).bind(i64::from(limit)+1)
            .fetch_all(&mut *tx).await.map_err(db)?;
        let more = rows.len() > limit as usize;
        let mut workers = Vec::new();
        for row in rows.iter().take(limit as usize) {
            let state = match row.get::<&str, _>("state") {
                "starting" => RunState::Starting,
                "running" => RunState::Running,
                "awaiting_acceptance" => RunState::AwaitingAcceptance,
                "cancel_requested" => RunState::CancelRequested,
                "cancelled" => RunState::Cancelled,
                "failed" => RunState::Failed,
                "blocked" => RunState::Blocked,
                "succeeded" => RunState::Succeeded,
                _ => return Err(RuntimeStoreError::Unavailable),
            };
            workers.push(WorkerExecutionSummary {
                run_id: orkestr_v2_contracts::RunId(
                    row.get::<String, _>("id").parse().map_err(db)?,
                ),
                session_id: orkestr_v2_contracts::SessionId(
                    row.get::<String, _>("session_id").parse().map_err(db)?,
                ),
                parent_run_id: orkestr_v2_contracts::RunId(
                    row.get::<String, _>("parent_run_id").parse().map_err(db)?,
                ),
                parent_session_id: orkestr_v2_contracts::SessionId(
                    row.get::<String, _>("parent_session_id")
                        .parse()
                        .map_err(db)?,
                ),
                source_message_id: orkestr_v2_contracts::MessageId(
                    row.get::<String, _>("message_id").parse().map_err(db)?,
                ),
                source_event_id: orkestr_v2_contracts::EventId(
                    row.get::<String, _>("event_id").parse().map_err(db)?,
                ),
                role: Role::Worker,
                state,
                control_revision: row.get("revision"),
                recovery: if state == RunState::Blocked
                    || row.get::<&str, _>("incarnation_id") != context.incarnation
                {
                    WorkerRecoveryDisposition::ReconciliationRequired
                } else {
                    WorkerRecoveryDisposition::CurrentIncarnation
                },
            });
        }
        let next_after = if more {
            workers.last().map(|w| w.run_id.clone())
        } else {
            None
        };
        let page = WorkerExecutionPage {
            schema_version: 1,
            conversation_id: conversation.clone(),
            revision,
            observed_at_ms: clock,
            workers,
            next_after,
        };
        if !page.is_valid() {
            return Err(RuntimeStoreError::Unavailable);
        }
        tx.commit().await.map_err(db)?;
        Ok(page)
    }
}
#[cfg(test)]
mod tests;
