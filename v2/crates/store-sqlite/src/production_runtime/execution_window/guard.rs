use super::*;

impl Context {
    pub(in crate::production_runtime) async fn window_scope(
        &self,
        tx: &mut SqliteConnection,
    ) -> Result<Option<SqliteRow>> {
        let row = sqlx::query("SELECT * FROM execution_windows WHERE credential_hash=?")
            .bind(&self.token_hash)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        if let Some(w) = &row {
            let current:i64=sqlx::query_scalar("SELECT count(*) FROM production_supervisors WHERE context_id=? AND incarnation_id=? AND generation=? AND owner_id=?")
                .bind(&self.id).bind(&self.incarnation).bind(self.generation).bind(self.owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
            if current != 1 {
                return Err(RuntimeStoreError::Fenced);
            }

            if w.get::<String, _>("owner_id") != self.owner.to_string()
                || w.get::<Option<String>, _>("context_id").as_deref() != Some(&self.id)
                || w.get::<Option<String>, _>("incarnation_id").as_deref()
                    != Some(&self.incarnation)
                || w.get::<i64, _>("credential_bound") != 1
            {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        Ok(row)
    }
}
impl Store {
    pub(crate) async fn execution_window_input_in(
        &self,
        tx: &mut SqliteConnection,
        conversation: &ConversationId,
        event: Option<&EventId>,
    ) -> Result<Option<String>> {
        let Some(c) = &self.authority else {
            return Ok(None);
        };
        if c.window_bootstrap_only {
            return Err(RuntimeStoreError::Fenced);
        }
        let Some(w) = c.window_scope(tx).await? else {
            return Ok(None);
        };
        if c.provider != ProviderKind::Codex
            || w.get::<String, _>("conversation_id") != conversation.to_string()
            || w.get::<&str, _>("state") != "active"
            || w.get::<i64, _>("work_deadline_ms") <= now(tx).await?
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let id: String = w.get("id");
        if let Some(event) = event {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM execution_window_inputs WHERE window_id=? AND event_id=?",
            )
            .bind(&id)
            .bind(event.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            if count != 1 {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        Ok(Some(id))
    }
    pub(in crate::production_runtime) async fn window_metadata_in(
        &self,
        tx: &mut SqliteConnection,
        binding: &Binding,
    ) -> Result<()> {
        let c = self.context()?;
        if c.window_bootstrap_only {
            return Err(RuntimeStoreError::Fenced);
        }
        let Some(w) = c.window_scope(tx).await? else {
            return Ok(());
        };
        if c.provider != ProviderKind::Codex
            || w.get::<String, _>("conversation_id") != binding.conversation_id.to_string()
            || !matches!(w.get::<&str, _>("state"), "opening" | "active")
            || w.get::<i64, _>("work_deadline_ms") <= now(tx).await?
            || (binding.role == Role::Worker
                && (w.get::<&str, _>("state") != "active" || binding.parent_session_id.is_none()))
            || (binding.role != Role::Worker && binding.parent_session_id.is_some())
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
    pub(in crate::production_runtime) async fn window_effect_in(
        &self,
        tx: &mut SqliteConnection,
        p: &ProviderAdmission,
        event: &str,
        cleanup: bool,
    ) -> Result<()> {
        let c = self.context()?;
        if c.window_bootstrap_only {
            return Err(RuntimeStoreError::Fenced);
        }
        let Some(w) = c.window_scope(tx).await? else {
            return Ok(());
        };
        if w.get::<String, _>("conversation_id") != p.run.conversation_id.to_string() {
            return Err(RuntimeStoreError::Fenced);
        }
        // Worker task inputs are separate events. Their authority remains the
        // exact consumed Deep parent whose ordinary input belongs to this window.
        let source = if p.run.role == Role::Worker {
            let parent = sqlx::query_scalar::<_, String>("SELECT p.event_id FROM production_runs r JOIN worker_provider_delegations d ON d.id=r.worker_delegation_id JOIN production_runs p ON p.id=d.parent_run_id JOIN execution_window_inputs i ON i.event_id=p.event_id WHERE r.id=? AND r.owner_id=? AND r.context_id=? AND r.incarnation_id=? AND r.role='worker' AND r.session_id=? AND d.worker_session_id=r.session_id AND d.parent_session_id=p.session_id AND p.role='deep' AND p.owner_id=r.owner_id AND p.conversation_id=r.conversation_id AND p.context_id=r.context_id AND p.incarnation_id=r.incarnation_id AND i.window_id=?")
                .bind(p.run.run_id.to_string()).bind(c.owner.to_string()).bind(&c.id)
                .bind(&c.incarnation).bind(p.run.session_id.to_string()).bind(w.get::<String,_>("id"))
                .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
            EventId(parent.parse().map_err(db)?)
        } else {
            EventId(event.parse().map_err(db)?)
        };
        if cleanup {
            let membership: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM execution_window_inputs WHERE window_id=? AND event_id=?",
            )
            .bind(w.get::<String, _>("id"))
            .bind(source.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            if membership != 1 {
                return Err(RuntimeStoreError::Fenced);
            }
            if !matches!(
                w.get::<&str, _>("state"),
                "active" | "retiring" | "reconciliation_required"
            ) || w.get::<i64, _>("expires_at_ms") <= now(tx).await?
            {
                return Err(RuntimeStoreError::Expired);
            }
        } else {
            self.execution_window_input_in(tx, &p.run.conversation_id, Some(&source))
                .await?;
        }
        Ok(())
    }
    pub(in crate::production_runtime) async fn rebind_execution_window_in(
        &self,
        tx: &mut SqliteConnection,
        old_incarnation: &str,
    ) -> Result<()> {
        let c = self.context()?;
        let row = sqlx::query("SELECT * FROM execution_windows WHERE credential_hash=?")
            .bind(&c.token_hash)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        let Some(w) = row else { return Ok(()) };
        if w.get::<String, _>("owner_id") != c.owner.to_string()
            || w.get::<Option<String>, _>("context_id").as_deref() != Some(&c.id)
            || w.get::<Option<String>, _>("incarnation_id").as_deref() != Some(old_incarnation)
            || w.get::<&str, _>("state") != "opening"
            || w.get::<i64, _>("credential_bound") != 0
            || w.get::<i64, _>("work_deadline_ms") <= now(tx).await?
        {
            return Err(RuntimeStoreError::Fenced);
        }
        if let Some(predecessor) = w.get::<Option<String>, _>("predecessor_window_id") {
            sqlx::query("DELETE FROM auth_sessions WHERE token_hash IN (SELECT credential_hash FROM execution_windows WHERE id=? AND state='closed')")
                .bind(predecessor).execute(&mut *tx).await.map_err(db)?;
        }
        sqlx::query("UPDATE execution_windows SET incarnation_id=?,credential_bound=1 WHERE id=?")
            .bind(&c.incarnation)
            .bind(w.get::<String, _>("id"))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        Ok(())
    }
}
