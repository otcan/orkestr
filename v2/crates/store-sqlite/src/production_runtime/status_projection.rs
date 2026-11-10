//! Shared execution projection within an already-owned read snapshot.
use super::*;
use orkestr_v2_contracts::{
    ConversationId, ExecutionCapabilities, ExecutionPhase, ExecutionStatus, RunId,
};

/// The failure class of a run's terminal failure. CROSS JOIN fixes the join
/// order (the run's few classes, then each one's observation by key): left to
/// choose, the planner walks every observation of every run, once per read of
/// a failed or cancelled conversation.
const FAILURE_CLASS: &str = "SELECT f.class FROM production_failure_classes f CROSS JOIN production_observations o ON o.event_id=f.event_id WHERE f.run_id=? AND o.kind='failed' AND (? OR f.class='policy') ORDER BY o.run_sequence DESC LIMIT 1";

impl Store {
    #[allow(
        clippy::too_many_arguments,
        reason = "retains the existing scoped projection options plus the shared transaction"
    )]
    pub(super) async fn execution_status_snapshot(
        &self,
        tx: &mut SqliteConnection,
        owner: &OwnerId,
        conversation: &ConversationId,
        exact_run: Option<&RunId>,
        credential: Option<&str>,
        fast_only: bool,
    ) -> Result<Option<ExecutionStatus>> {
        #[cfg(test)]
        self.status_read_counts()
            .execution
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Some(credential) = credential {
            let authorized: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
                .bind(crate::digest(credential)).bind(owner.to_string())
                .fetch_one(&mut *tx).await.map_err(db)?;
            if authorized != 1 {
                return Err(RuntimeStoreError::Unauthorized);
            }
        }
        crate::runtime::scope(&mut *tx, owner, conversation).await?;
        if let Some(context) = &self.authority {
            if context.owner != *owner {
                return Err(RuntimeStoreError::Unauthorized);
            }
            context.authenticate(&mut *tx).await?;
        }
        let observed_at_ms = now(&mut *tx).await?;
        let revision: i64 =
            sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
                .bind(conversation.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        let run = if let Some(id) = exact_run {
            if let Some(context) = &self.authority {
                context.validate(&mut *tx).await?;
                sqlx::query("SELECT id,state FROM production_runs WHERE id=? AND owner_id=? AND conversation_id=? AND context_id=? AND incarnation_id=?")
                    .bind(id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(&context.id).bind(&context.incarnation)
                    .fetch_optional(&mut *tx).await.map_err(db)?
            } else {
                sqlx::query("SELECT id,state FROM production_runs WHERE id=? AND owner_id=? AND conversation_id=? AND ((?=1 AND role='fast') OR (?=0 AND role IN ('deep','worker')))")
                    .bind(id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
                    .bind(fast_only).bind(fast_only)
                    .fetch_optional(&mut *tx).await.map_err(db)?
            }
        } else if fast_only {
            let context = self.context()?;
            context.validate(&mut *tx).await?;
            sqlx::query("SELECT id,state FROM production_runs WHERE owner_id=? AND conversation_id=? AND context_id=? AND incarnation_id=? AND role='fast' ORDER BY scope_sequence DESC,id DESC LIMIT 1")
                .bind(owner.to_string()).bind(conversation.to_string()).bind(&context.id).bind(&context.incarnation)
                .fetch_optional(&mut *tx).await.map_err(db)?
        } else {
            // The conversation's Deep status is its canonical lineage's; a
            // read-only parallel slot run is read by its exact run ID only.
            let canonical = if super::parallel_deep::present(&mut *tx).await? {
                format!(
                    " AND {}",
                    super::parallel_deep::canonical_run("production_runs")
                )
            } else {
                String::new()
            };
            sqlx::query(&format!("SELECT id,state FROM production_runs WHERE owner_id=? AND conversation_id=? AND role='deep'{canonical} ORDER BY scope_sequence DESC LIMIT 1"))
                .bind(owner.to_string()).bind(conversation.to_string()).fetch_optional(&mut *tx).await.map_err(db)?
        };
        let queued: Option<i64> = if exact_run.is_some() || fast_only {
            None
        } else {
            sqlx::query_scalar("SELECT CAST((julianday(e.occurred_at)-2440587.5)*86400000 AS INTEGER) FROM reasoning_inbox i JOIN events e ON e.id=i.event_id WHERE i.conversation_id=? AND i.state IN ('queued','claimed') AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=i.event_id) ORDER BY i.sequence LIMIT 1")
                .bind(conversation.to_string()).fetch_optional(&mut *tx).await.map_err(db)?
        };
        let (run_id, phase) = match run {
            Some(row) => (
                Some(RunId(row.get::<String, _>("id").parse().map_err(db)?)),
                match row.get::<&str, _>("state") {
                    "starting" => ExecutionPhase::Starting,
                    "cancel_requested" => ExecutionPhase::CancelRequested,
                    "cancelled" => ExecutionPhase::Cancelled,
                    "succeeded" => ExecutionPhase::Completed,
                    "blocked" => ExecutionPhase::Blocked,
                    "running" => ExecutionPhase::Running,
                    "awaiting_acceptance" => ExecutionPhase::AwaitingAcceptance,
                    "failed" => ExecutionPhase::Failed,
                    _ => return Err(RuntimeStoreError::Unavailable),
                },
            ),
            None if queued.is_some() => (None, ExecutionPhase::Queued),
            None => {
                return Ok(None);
            }
        };
        let progress = if let Some(run) = &run_id {
            sqlx::query("SELECT p.id,CAST((julianday(e.occurred_at)-2440587.5)*86400000 AS INTEGER) AS at_ms FROM production_payloads p JOIN events e ON e.id=p.event_id WHERE p.run_id=? AND p.owner_id=? AND p.conversation_id=? ORDER BY e.sequence DESC LIMIT 1")
                .bind(run.to_string()).bind(owner.to_string()).bind(conversation.to_string()).fetch_optional(&mut *tx).await.map_err(db)?
                .map(|row| -> Result<_> { Ok(orkestr_v2_contracts::ExecutionProgress { payload_id: orkestr_v2_contracts::PayloadId(row.get::<String,_>("id").parse().map_err(db)?), observed_at_ms: row.get("at_ms") }) }).transpose()?
        } else {
            None
        };
        let acceptance_candidate = if phase == ExecutionPhase::AwaitingAcceptance {
            let run = run_id.as_ref().ok_or(RuntimeStoreError::Unavailable)?;
            let completions: Vec<String> = sqlx::query_scalar("SELECT o.event_id FROM production_observations o JOIN events e ON e.id=o.event_id WHERE o.run_id=? AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance' AND e.owner_id=? AND e.conversation_id=? AND e.kind='provider_observed' AND e.schema_version=5")
                .bind(run.to_string()).bind(owner.to_string()).bind(conversation.to_string())
                .fetch_all(&mut *tx).await.map_err(db)?;
            if completions.len() != 1 {
                return Err(RuntimeStoreError::Unavailable);
            }
            Some(orkestr_v2_contracts::ExecutionAcceptanceCandidate {
                run_id: run.clone(),
                completion_event_id: orkestr_v2_contracts::EventId(
                    completions[0].parse().map_err(db)?,
                ),
            })
        } else {
            None
        };
        let failure = match (&run_id, phase) {
            (Some(run), ExecutionPhase::Failed | ExecutionPhase::Cancelled) => {
                sqlx::query_scalar::<_, String>(FAILURE_CLASS)
                    .bind(run.to_string())
                    .bind(phase == ExecutionPhase::Failed)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(db)?
                    .and_then(|class| super::observations::failure_class(&class))
                    .map(|class| orkestr_v2_contracts::ExecutionFailure { class })
            }
            _ => None,
        };
        let control_revision = if let Some(run) = &run_id {
            Some(
                sqlx::query_scalar::<_, i64>(
                    "SELECT revision FROM production_control_revisions WHERE run_id=?",
                )
                .bind(run.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?,
            )
        } else {
            None
        };
        let models = if let Some(run) = &run_id {
            let rows = sqlx::query(
                "SELECT source,model FROM production_run_models WHERE run_id=? ORDER BY sequence",
            )
            .bind(run.to_string())
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;
            let mut models = orkestr_v2_contracts::ExecutionModels::default();
            let provider: String =
                sqlx::query_scalar("SELECT provider_kind FROM production_runs WHERE id=?")
                    .bind(run.to_string())
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(db)?;
            models.provider = Some(match provider.as_str() {
                "codex" => orkestr_v2_contracts::ConversationProvider::Codex,
                "claude" => orkestr_v2_contracts::ConversationProvider::Claude,
                _ => return Err(RuntimeStoreError::Unavailable),
            });
            for row in rows {
                match row.get::<&str, _>("source") {
                    "resolved" => models.resolved_model = Some(row.get("model")),
                    "answer" => models.actual_model = Some(row.get("model")),
                    "refused" => models.refused_model = Some(row.get("model")),
                    _ => return Err(RuntimeStoreError::Unavailable),
                }
            }
            Some(models)
        } else {
            None
        };
        let status = ExecutionStatus {
            models,
            failure,
            schema_version: 1,
            conversation_id: conversation.clone(),
            run_id,
            revision,
            control_revision,
            observed_at_ms,
            phase,
            acceptance_candidate,
            queue_age_ms: queued.map(|time| observed_at_ms.saturating_sub(time).max(0) as u64),
            progress,
            resources: None,
            capabilities: ExecutionCapabilities {
                stop: false,
                steer: false,
            },
        };
        Ok(Some(status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production_runtime::tests::setup;

    #[tokio::test]
    async fn failure_class_starts_from_the_runs_own_rows() {
        let f = setup().await;
        let plan: Vec<String> = sqlx::query(&format!("EXPLAIN QUERY PLAN {FAILURE_CLASS}"))
            .bind("run")
            .bind(true)
            .fetch_all(&f.store.pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get("detail"))
            .collect();
        assert!(
            plan.iter()
                .any(|step| step.starts_with("SEARCH o") && step.contains("event_id=?")),
            "observations must be read by key: {plan:?}"
        );
        assert!(
            !plan.iter().any(|step| step.starts_with("SCAN o")),
            "observations must not be walked: {plan:?}"
        );
    }
}
