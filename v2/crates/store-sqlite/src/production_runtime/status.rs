use super::*;
#[cfg(test)]
use orkestr_v2_contracts::ExecutionPhase;
use orkestr_v2_contracts::ExecutionStatus;
use orkestr_v2_contracts::{ConversationId, RunId};

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
    /// Whether one exact Fast reply was part of a burst: presented by an
    /// extra slot (`fast_slot>0`), or another Fast run of the same window
    /// incarnation is live right now. A channel quotes such a reply's source
    /// message so out-of-order replies stay attributable. Read-time sample;
    /// same browser-session authentication as the exact-run status.
    pub async fn fast_run_concurrent_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        run: &RunId,
    ) -> Result<bool> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let authorized: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(crate::digest(credential)).bind(owner.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if authorized != 1 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let row = sqlx::query("SELECT (SELECT b.fast_slot FROM session_bindings b WHERE b.id=r.session_id) AS slot, (SELECT count(*) FROM production_runs o WHERE o.role='fast' AND o.context_id=r.context_id AND o.incarnation_id=r.incarnation_id AND o.id!=r.id AND o.state NOT IN ('succeeded','cancelled','failed','blocked')) AS live FROM production_runs r WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND r.role='fast'")
            .bind(run.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(row.is_some_and(|row| {
            row.get::<Option<i64>, _>("slot").unwrap_or(0) > 0 || row.get::<i64, _>("live") > 0
        }))
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
        let status = self
            .execution_status_snapshot(
                &mut tx,
                owner,
                conversation,
                exact_run,
                credential,
                fast_only,
            )
            .await?;
        tx.commit().await.map_err(db)?;
        Ok(status)
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
