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
        let mut tx = self.pool.begin().await.map_err(db)?;
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
        let run = sqlx::query("SELECT id,state FROM production_runs WHERE owner_id=? AND conversation_id=? ORDER BY scope_sequence DESC LIMIT 1")
            .bind(owner.to_string()).bind(conversation.to_string()).fetch_optional(&mut *tx).await.map_err(db)?;
        let queued: Option<i64> = sqlx::query_scalar("SELECT CAST((julianday(e.occurred_at)-2440587.5)*86400000 AS INTEGER) FROM reasoning_inbox i JOIN events e ON e.id=i.event_id WHERE i.conversation_id=? AND i.state!='consumed' ORDER BY i.sequence LIMIT 1")
            .bind(conversation.to_string()).fetch_optional(&mut *tx).await.map_err(db)?;
        let (run_id, phase) = match run {
            Some(row) => (
                Some(RunId(row.get::<String, _>("id").parse().map_err(db)?)),
                match row.get::<&str, _>("state") {
                    "starting" => ExecutionPhase::Starting,
                    "blocked" => ExecutionPhase::Blocked,
                    _ => return Err(RuntimeStoreError::Unavailable),
                },
            ),
            None if queued.is_some() => (None, ExecutionPhase::Queued),
            None => {
                tx.commit().await.map_err(db)?;
                return Ok(None);
            }
        };
        let status = ExecutionStatus {
            schema_version: 1,
            conversation_id: conversation.clone(),
            run_id,
            revision,
            observed_at_ms,
            phase,
            queue_age_ms: queued.map(|time| observed_at_ms.saturating_sub(time).max(0) as u64),
            progress: None,
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
