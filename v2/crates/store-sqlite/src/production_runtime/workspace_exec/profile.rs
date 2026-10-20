use super::*;

/// Trusted local opt-in. A workspace path or read-only metadata grant alone does
/// not authorize commands. This nonserializable handle pins exact project scope.
pub struct WorkspaceExecProfile {
    pub(super) workspace: Arc<WorkspaceGrant>,
}
impl WorkspaceExecProfile {
    pub(super) async fn validate(&self, store: &Store, conn: &mut SqliteConnection) -> Result<()> {
        store.workspace_grant_in(conn, &self.workspace).await?;
        let (project, generation, conversation) = self.workspace.exec_identity();
        let enabled: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_exec_profiles WHERE project_id=? AND owner_id=? AND conversation_id=? AND project_generation=? AND enabled=1")
            .bind(project).bind(store.context()?.owner.to_string()).bind(conversation.to_string())
            .bind(generation).fetch_one(conn).await.map_err(db)?;
        if enabled != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
}
impl Store {
    /// Trusted bootstrap only, before native readiness. This is not an HTTP DTO.
    /// Reopening an existing opt-in never reverses an explicit revocation.
    pub async fn install_workspace_exec(
        &self,
        credential: &str,
        workspace: &Arc<WorkspaceGrant>,
    ) -> Result<WorkspaceExecProfile> {
        self.worker_credential(credential)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.workspace_grant_in(&mut tx, workspace).await?;
        let (project, generation, conversation) = workspace.exec_identity();
        let existing = sqlx::query("SELECT * FROM workspace_exec_profiles WHERE project_id=?")
            .bind(project)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        if let Some(row) = existing {
            if row.get::<String, _>("owner_id") != self.context()?.owner.to_string()
                || row.get::<String, _>("conversation_id") != conversation.to_string()
                || row.get::<i64, _>("project_generation") != generation
                || row.get::<i64, _>("enabled") != 1
            {
                return Err(RuntimeStoreError::Fenced);
            }
        } else {
            let established: i64 = sqlx::query_scalar("SELECT count(*) FROM production_readiness r JOIN session_bindings b ON b.id=r.session_id WHERE b.conversation_id=?")
                .bind(conversation.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
            if established != 0 {
                return Err(RuntimeStoreError::Busy);
            }
            sqlx::query("INSERT INTO workspace_exec_profiles VALUES(?,?,?,?,1)")
                .bind(project)
                .bind(self.context()?.owner.to_string())
                .bind(conversation.to_string())
                .bind(generation)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(WorkspaceExecProfile {
            workspace: workspace.clone(),
        })
    }
    pub async fn revoke_workspace_exec(
        &self,
        credential: &str,
        profile: &WorkspaceExecProfile,
    ) -> Result<()> {
        self.worker_credential(credential)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.workspace_grant_in(&mut tx, &profile.workspace).await?;
        let (project, generation, _) = profile.workspace.exec_identity();
        let changed = sqlx::query("UPDATE workspace_exec_profiles SET enabled=0 WHERE project_id=? AND project_generation=? AND enabled=1")
            .bind(project).bind(generation).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}
