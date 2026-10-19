use super::*;
impl Store {
    /// Trusted local installation only. An existing project requires exact reopen
    /// or explicit replacement; a path, inventory or UUID cannot issue authority.
    pub async fn register_workspace(
        &self,
        credential: &str,
        conversation: &ConversationId,
        project: Uuid,
        installation: WorkspaceInstallation,
    ) -> Result<WorkspaceGrant> {
        self.worker_credential(credential)?;
        if project.is_nil() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let c = self.context()?;
        c.require_provider_context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let owned: i64 =
            sqlx::query_scalar("SELECT count(*) FROM conversations WHERE id=? AND owner_id=?")
                .bind(conversation.to_string())
                .bind(c.owner.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if owned != 1 {
            return Err(RuntimeStoreError::NotFound);
        }
        installation.inner.check()?;
        let databases = sqlx::query("PRAGMA database_list")
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;
        for database in databases {
            let file: String = database.get("file");
            if !file.is_empty() {
                installation.inner.reject_overlap(
                    std::path::Path::new(&file)
                        .parent()
                        .ok_or(RuntimeStoreError::Fenced)?,
                )?;
            }
        }
        let existing =
            sqlx::query("SELECT * FROM workspace_projects WHERE owner_id=? AND conversation_id=?")
                .bind(c.owner.to_string())
                .bind(conversation.to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
        let generation = if let Some(row) = existing {
            if row.get::<String, _>("id") != project.to_string()
                || row.get::<i64, _>("active") != 1
                || row.get::<String, _>("identity_json") != installation.inner.fingerprint()
            {
                return Err(RuntimeStoreError::Conflict);
            }
            row.get("generation")
        } else {
            // Adding authority cannot retroactively bless an already running child.
            let live:i64=sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE conversation_id=? AND state IN('starting','running','cancel_requested')").bind(conversation.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
            let established:i64=sqlx::query_scalar("SELECT count(*) FROM production_readiness r JOIN session_bindings b ON b.id=r.session_id WHERE b.conversation_id=?").bind(conversation.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
            if live != 0 || established != 0 {
                return Err(RuntimeStoreError::Busy);
            }
            sqlx::query("INSERT INTO workspace_projects(id,owner_id,conversation_id,generation,active,identity_json) VALUES(?,?,?,1,1,?)").bind(project.to_string()).bind(c.owner.to_string()).bind(conversation.to_string()).bind(installation.inner.fingerprint()).execute(&mut *tx).await.map_err(db)?;
            1
        };
        tx.commit().await.map_err(db)?;
        self.workspace_handles
            .0
            .lock()
            .map_err(db)?
            .insert(project.to_string(), installation.inner.clone());
        Ok(WorkspaceGrant {
            project: project.to_string(),
            generation,
            conversation: conversation.clone(),
            context: c.clone(),
            installation: installation.inner,
        })
    }
    /// Explicit generation replacement. Existing sessions remain bound to the
    /// old generation and cannot silently acquire the replacement project.
    pub async fn replace_workspace(
        &self,
        credential: &str,
        grant: &WorkspaceGrant,
        installation: WorkspaceInstallation,
    ) -> Result<WorkspaceGrant> {
        self.worker_credential(credential)?;
        installation.inner.check()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.workspace_grant_in(&mut tx, grant).await?;
        for row in sqlx::query("PRAGMA database_list")
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?
        {
            let file: String = row.get("file");
            if !file.is_empty() {
                installation.inner.reject_overlap(
                    std::path::Path::new(&file)
                        .parent()
                        .ok_or(RuntimeStoreError::Fenced)?,
                )?;
            }
        }
        let next = grant
            .generation
            .checked_add(1)
            .ok_or(RuntimeStoreError::Unavailable)?;
        sqlx::query("UPDATE workspace_projects SET generation=?,identity_json=? WHERE id=?")
            .bind(next)
            .bind(installation.inner.fingerprint())
            .bind(&grant.project)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        self.workspace_handles
            .0
            .lock()
            .map_err(db)?
            .insert(grant.project.clone(), installation.inner.clone());
        Ok(WorkspaceGrant {
            project: grant.project.clone(),
            generation: next,
            conversation: grant.conversation.clone(),
            context: grant.context.clone(),
            installation: installation.inner,
        })
    }
    pub async fn revoke_workspace(&self, credential: &str, grant: &WorkspaceGrant) -> Result<()> {
        self.worker_credential(credential)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        // Revocation remains possible after a filesystem replacement.
        let c = self.context()?;
        c.validate(&mut tx).await?;
        if c.id != grant.context.id || c.incarnation != grant.context.incarnation {
            return Err(RuntimeStoreError::Fenced);
        }
        let changed=sqlx::query("UPDATE workspace_projects SET active=0,generation=generation+1 WHERE id=? AND owner_id=? AND generation=? AND active=1").bind(&grant.project).bind(c.owner.to_string()).bind(grant.generation).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }
    /// Exact session association, before metadata issuance. Ready/Starting only;
    /// neither a run locator nor a browser path can bind a project.
    pub async fn bind_workspace_session(
        &self,
        credential: &str,
        grant: &WorkspaceGrant,
        binding: &Binding,
    ) -> Result<()> {
        self.worker_credential(credential)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.workspace_grant_in(&mut tx, grant).await?;
        let row = sqlx::query("SELECT * FROM session_bindings WHERE id=? AND owner_id=?")
            .bind(binding.session_id.to_string())
            .bind(grant.context.owner.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(RuntimeStoreError::NotFound)?;
        if crate::runtime::binding(&row)? != *binding
            || binding.conversation_id != grant.conversation
            || !matches!(binding.state, SessionState::Starting | SessionState::Ready)
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let old = sqlx::query("SELECT * FROM workspace_session_projects WHERE session_id=?")
            .bind(binding.session_id.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        if let Some(old) = old {
            if old.get::<String, _>("project_id") != grant.project
                || old.get::<i64, _>("generation") != grant.generation
            {
                return Err(RuntimeStoreError::Fenced);
            }
            // A new incarnation may rebind only after sealed terminal restart;
            // its metadata issuer independently enforces retirement provenance.
            sqlx::query("UPDATE workspace_session_projects SET context_id=?,incarnation_id=? WHERE session_id=?").bind(&grant.context.id).bind(&grant.context.incarnation).bind(binding.session_id.to_string()).execute(&mut *tx).await.map_err(db)?;
        } else {
            sqlx::query("INSERT INTO workspace_session_projects VALUES(?,?,?,?,?)")
                .bind(binding.session_id.to_string())
                .bind(&grant.project)
                .bind(grant.generation)
                .bind(&grant.context.id)
                .bind(&grant.context.incarnation)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}
