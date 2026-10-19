//! Same-transaction terminal restart association, never project replacement.
use super::*;
impl Store {
    pub(in crate::production_runtime) async fn rebind_terminal_workspace_in(
        &self,
        tx: &mut SqliteConnection,
        binding: &Binding,
        predecessor: &str,
        project: Uuid,
        installation: WorkspaceInstallation,
    ) -> Result<WorkspaceGrant> {
        let c = self.context()?;
        c.validate(tx).await?;
        if project.is_nil() || binding.owner_id != c.owner {
            return Err(RuntimeStoreError::Fenced);
        }
        installation.inner.check()?;
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
        let changed = sqlx::query("UPDATE workspace_session_projects SET incarnation_id=? WHERE session_id=? AND project_id=? AND context_id=? AND incarnation_id=? AND EXISTS(SELECT 1 FROM workspace_projects p WHERE p.id=workspace_session_projects.project_id AND p.owner_id=? AND p.conversation_id=? AND p.active=1 AND p.generation=workspace_session_projects.generation AND p.identity_json=?)")
            .bind(&c.incarnation).bind(binding.session_id.to_string()).bind(project.to_string())
            .bind(&c.id).bind(predecessor).bind(c.owner.to_string())
            .bind(binding.conversation_id.to_string()).bind(installation.inner.fingerprint())
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        // A rolled-back transaction cannot bless this local registry entry:
        // every effect still checks the durable association/generation/identity.
        self.workspace_handles
            .0
            .lock()
            .map_err(db)?
            .insert(project.to_string(), installation.inner.clone());
        Ok(WorkspaceGrant {
            project: project.to_string(),
            generation: sqlx::query_scalar("SELECT generation FROM workspace_projects WHERE id=?")
                .bind(project.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?,
            conversation: binding.conversation_id.clone(),
            context: c.clone(),
            installation: installation.inner,
        })
    }
}
