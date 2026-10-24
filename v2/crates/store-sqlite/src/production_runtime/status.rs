use super::*;
use orkestr_v2_contracts::{ConversationId, RunId};
use orkestr_v2_contracts::{ExecutionCapabilities, ExecutionPhase, ExecutionStatus};

impl Store {
    /// Owner-scoped snapshot. The authenticated server supplies owner identity;
    /// absence means no admitted execution and no queued input, never success.
    pub async fn execution_status(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<Option<ExecutionStatus>> {
        self.execution_status_in_scope(owner, conversation, None, None, false)
            .await
    }
    /// Bound supervisor read of one exact run, including independent Workers.
    /// Credential, context and owner scope are checked in the read transaction.
    /// This is evidence only; it cannot reconstruct execution or control authority.
    pub async fn execution_run_status(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        run: &RunId,
    ) -> Result<Option<ExecutionStatus>> {
        self.worker_credential(credential)?;
        if self.context()?.owner != *owner {
            return Err(RuntimeStoreError::Unauthorized);
        }
        self.execution_status_in_scope(owner, conversation, Some(run), None, false)
            .await
    }
    /// Browser read boundary. The exact current credential and bound supervisor
    /// are authenticated in the same snapshot as the exact-run projection.
    /// This read issues no execution or cancellation authority.
    pub async fn execution_run_status_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        run: &RunId,
    ) -> Result<Option<ExecutionStatus>> {
        if credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let owner = &self
            .authority
            .as_ref()
            .ok_or(RuntimeStoreError::Unauthorized)?
            .owner;
        self.execution_status_in_scope(owner, conversation, Some(run), Some(credential), false)
            .await
    }
    /// Current browser credential and exact owner/run history, independent of
    /// the runtime incarnation. Fast and Deep/Worker route roles stay separate;
    /// this unbound read never supplies controls.
    pub async fn execution_run_history_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        run: &RunId,
        fast_only: bool,
    ) -> Result<Option<ExecutionStatus>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if owner.0.is_nil() || conversation.0.is_nil() || run.0.is_nil() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        self.execution_status_in_scope(owner, conversation, Some(run), Some(credential), fast_only)
            .await
    }
    /// Latest Fast execution in this exact live supervisor context. No Deep queue
    /// projection or execution authority is returned.
    pub async fn execution_fast_status(
        &self,
        credential: &str,
        conversation: &ConversationId,
    ) -> Result<Option<ExecutionStatus>> {
        self.worker_credential(credential)?;
        let owner = &self.context()?.owner;
        self.execution_status_in_scope(owner, conversation, None, None, true)
            .await
    }

    /// Current browser-session authenticated Fast-only projection.
    pub async fn execution_fast_status_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
    ) -> Result<Option<ExecutionStatus>> {
        if credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let owner = &self.context()?.owner;
        self.execution_status_in_scope(owner, conversation, None, Some(credential), true)
            .await
    }
    async fn execution_status_in_scope(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        exact_run: Option<&RunId>,
        credential: Option<&str>,
        fast_only: bool,
    ) -> Result<Option<ExecutionStatus>> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        if let Some(credential) = credential {
            let authorized: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
                .bind(crate::digest(credential)).bind(owner.to_string())
                .fetch_one(&mut *tx).await.map_err(db)?;
            if authorized != 1 {
                return Err(RuntimeStoreError::Unauthorized);
            }
        }
        crate::runtime::scope(&mut tx, owner, conversation).await?;
        if let Some(context) = &self.authority {
            if context.owner != *owner {
                return Err(RuntimeStoreError::Unauthorized);
            }
            context.authenticate(&mut tx).await?;
        }
        let observed_at_ms = now(&mut tx).await?;
        let revision: i64 =
            sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
                .bind(conversation.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        let run = if let Some(id) = exact_run {
            if let Some(context) = &self.authority {
                context.validate(&mut tx).await?;
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
            context.validate(&mut tx).await?;
            sqlx::query("SELECT id,state FROM production_runs WHERE owner_id=? AND conversation_id=? AND context_id=? AND incarnation_id=? AND role='fast' ORDER BY scope_sequence DESC,id DESC LIMIT 1")
                .bind(owner.to_string()).bind(conversation.to_string()).bind(&context.id).bind(&context.incarnation)
                .fetch_optional(&mut *tx).await.map_err(db)?
        } else {
            sqlx::query("SELECT id,state FROM production_runs WHERE owner_id=? AND conversation_id=? AND role='deep' ORDER BY scope_sequence DESC LIMIT 1")
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
                tx.commit().await.map_err(db)?;
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
            (Some(run), ExecutionPhase::Failed | ExecutionPhase::Cancelled) => sqlx::query_scalar::<_, String>(
                "SELECT f.class FROM production_failure_classes f JOIN production_observations o ON o.event_id=f.event_id WHERE f.run_id=? AND o.kind='failed' AND (? OR f.class='policy') ORDER BY o.run_sequence DESC LIMIT 1",
            )
            .bind(run.to_string())
            .bind(phase == ExecutionPhase::Failed)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .and_then(|class| super::observations::failure_class(&class))
            .map(|class| orkestr_v2_contracts::ExecutionFailure { class }),
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
        tx.commit().await.map_err(db)?;
        Ok(Some(status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production_runtime::tests::{claim, ready, setup};
    #[tokio::test]
    async fn scoped_revision_advances_only_with_committed_authority_changes() {
        let f = setup().await;
        assert!(f
            .store
            .execution_status(&f.owner, &f.conversation)
            .await
            .unwrap()
            .is_none());
        let b = ready(&f).await;
        let input = claim(&f, &b).await;
        let queued = f
            .store
            .execution_status(&f.owner, &f.conversation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(queued.phase, ExecutionPhase::Queued);
        assert!(queued.is_valid());
        assert!(!queued.capabilities.stop && !queued.capabilities.steer);
        let admitted = f
            .handle
            .admit_run(&input, &b.session_id, b.generation, "status-run")
            .await
            .unwrap();
        let started = f
            .store
            .execution_status(&f.owner, &f.conversation)
            .await
            .unwrap()
            .unwrap();
        assert!(started.revision > queued.revision);
        assert_eq!(started.phase, ExecutionPhase::Starting);
        assert_eq!(started.run_id.as_ref(), Some(&admitted.provider.run.run_id));
        f.handle
            .admit_run(&input, &b.session_id, b.generation, "status-run")
            .await
            .unwrap();
        let replay = f
            .store
            .execution_status(&f.owner, &f.conversation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(replay.revision, started.revision);
        let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
        assert_eq!(
            reopened
                .execution_status(&f.owner, &f.conversation)
                .await
                .unwrap()
                .unwrap()
                .revision,
            started.revision
        );
        let stranger = OwnerId(Uuid::new_v4());
        assert!(matches!(
            f.store.execution_status(&stranger, &f.conversation).await,
            Err(RuntimeStoreError::NotFound)
        ));
    }
}

#[cfg(test)]
mod browser_tests {
    use super::*;
    use crate::production_runtime::tests::{claim, ready, setup};

    #[tokio::test]
    async fn exact_run_browser_read_checks_current_credential_and_scope() {
        let f = setup().await;
        let binding = ready(&f).await;
        let claim = claim(&f, &binding).await;
        let admitted = f
            .handle
            .admit_run(
                &claim,
                &binding.session_id,
                binding.generation,
                "browser-status",
            )
            .await
            .unwrap();
        let run = &admitted.provider.run.run_id;
        let token = format!("browser:{}", "ab".repeat(32));
        f.store.save_session(&token, &f.owner).await.unwrap();
        let status = f
            .handle
            .execution_run_status_authenticated(&token, &f.conversation, run)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.run_id.as_ref(), Some(run));
        assert!(status.control_revision.is_some());
        assert!(status.is_valid());
        assert!(f
            .handle
            .execution_run_status_authenticated(&token, &f.conversation, &RunId(Uuid::new_v4()))
            .await
            .unwrap()
            .is_none());
        let foreign = format!("browser:{}", "cd".repeat(32));
        assert!(matches!(
            f.handle
                .execution_run_status_authenticated(&foreign, &f.conversation, run)
                .await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        f.store.revoke_session(&token).await.unwrap();
        assert!(matches!(
            f.handle
                .execution_run_status_authenticated(&token, &f.conversation, run)
                .await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert!(matches!(
            f.store
                .execution_run_status_authenticated(&token, &f.conversation, run)
                .await,
            Err(RuntimeStoreError::Unauthorized)
        ));
    }
}
