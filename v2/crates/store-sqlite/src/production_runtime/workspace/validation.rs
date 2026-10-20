use super::*;
impl Store {
    pub(in crate::production_runtime) async fn workspace_grant_in(
        &self,
        tx: &mut SqliteConnection,
        grant: &WorkspaceGrant,
    ) -> Result<()> {
        let c = self.context()?;
        c.validate(tx).await?;
        if c.id != grant.context.id
            || c.incarnation != grant.context.incarnation
            || c.token_hash != grant.context.token_hash
            || c.owner != grant.context.owner
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let count:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_projects WHERE id=? AND owner_id=? AND conversation_id=? AND generation=? AND active=1 AND identity_json=?")
            .bind(&grant.project).bind(c.owner.to_string()).bind(grant.conversation.to_string()).bind(grant.generation).bind(grant.installation.fingerprint()).fetch_one(&mut *tx).await.map_err(db)?;
        if count != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        grant.installation.check()
    }
    pub(in crate::production_runtime) async fn validate_workspace_binding(
        &self,
        tx: &mut SqliteConnection,
        binding: &Binding,
    ) -> Result<()> {
        // Upgrade fixtures construct historical Store handles to populate the
        // original schema before opening it through the current migrator.
        // Ordinary Store::open always installs migration 40 before use.
        #[cfg(test)]
        {
            let version: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success=1",
            )
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            if version < 40 {
                return Ok(());
            }
        }
        let row=sqlx::query("SELECT p.id,p.generation,p.active,p.identity_json,s.generation AS bound_generation,s.context_id,s.incarnation_id FROM workspace_projects p LEFT JOIN workspace_session_projects s ON s.project_id=p.id AND s.session_id=? WHERE p.owner_id=? AND p.conversation_id=?")
            .bind(binding.session_id.to_string()).bind(binding.owner_id.to_string()).bind(binding.conversation_id.to_string()).fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(row) = row else {
            return Ok(());
        };
        let c = self.context()?;
        if row.get::<i64, _>("active") != 1
            || row.try_get::<i64, _>("bound_generation").ok() != Some(row.get("generation"))
            || row.try_get::<String, _>("context_id").ok().as_deref() != Some(&c.id)
            || row.try_get::<String, _>("incarnation_id").ok().as_deref() != Some(&c.incarnation)
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let id: String = row.get("id");
        let installation = self
            .workspace_handles
            .0
            .lock()
            .map_err(db)?
            .get(&id)
            .cloned()
            .ok_or(RuntimeStoreError::Fenced)?;
        if installation.fingerprint() != row.get::<String, _>("identity_json") {
            return Err(RuntimeStoreError::Fenced);
        }
        installation.check()
    }
}
