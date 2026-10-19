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
        let Some(w) = c.window_scope(tx).await? else {
            return Ok(());
        };
        if c.provider != ProviderKind::Codex
            || binding.role != Role::Deep
            || w.get::<String, _>("conversation_id") != binding.conversation_id.to_string()
            || !matches!(w.get::<&str, _>("state"), "opening" | "active")
            || w.get::<i64, _>("work_deadline_ms") <= now(tx).await?
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
        let Some(w) = c.window_scope(tx).await? else {
            return Ok(());
        };
        if p.run.role != Role::Deep
            || w.get::<String, _>("conversation_id") != p.run.conversation_id.to_string()
        {
            return Err(RuntimeStoreError::Fenced);
        }
        if cleanup {
            if !matches!(
                w.get::<&str, _>("state"),
                "active" | "retiring" | "reconciliation_required"
            ) || w.get::<i64, _>("expires_at_ms") <= now(tx).await?
            {
                return Err(RuntimeStoreError::Expired);
            }
        } else {
            let event = EventId(event.parse().map_err(db)?);
            self.execution_window_input_in(tx, &p.run.conversation_id, Some(&event))
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
