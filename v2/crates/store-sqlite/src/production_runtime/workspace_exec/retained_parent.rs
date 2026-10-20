use super::*;

/// Delegation lineage retained before inference consumption. No inference,
/// tool launch or result-delivery authority is exposed by this handle.
pub struct WorkspaceExecParent {
    pub(super) profile: Arc<WorkspaceExecProfile>,
    pub(super) parent: Box<ProviderAdmission>,
    pub(super) namespace: String,
    pub(super) incarnation: String,
}

impl Store {
    pub async fn authorize_workspace_exec_parent(
        &self,
        credential: &str,
        consumed: &ConsumedProviderDispatch,
        profile: &Arc<WorkspaceExecProfile>,
    ) -> Result<WorkspaceExecParent> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        profile.validate(self, &mut tx).await?;
        execution(self, &mut tx, credential, consumed.provider()).await?;
        let c = self.context()?;
        if consumed.provider().run.role != Role::Worker
            || consumed.namespace() != c.namespace
            || consumed.incarnation_id() != c.incarnation
        {
            return Err(RuntimeStoreError::Fenced);
        }
        if consumed.provider().run.conversation_id != *profile.workspace.exec_identity().2 {
            return Err(RuntimeStoreError::Fenced);
        }
        let parent = WorkspaceExecParent {
            profile: profile.clone(),
            parent: Box::new(consumed.provider().clone()),
            namespace: c.namespace.clone(),
            incarnation: c.incarnation.clone(),
        };
        tx.commit().await.map_err(db)?;
        Ok(parent)
    }

    /// A validated native request supplies input, never authority. This retained
    /// handle and current credential are revalidated before replay or delegation.
    pub async fn delegate_workspace_exec_from_parent(
        &self,
        credential: &str,
        parent: &WorkspaceExecParent,
        request_key: &str,
        source: &str,
        lifetime_ms: u32,
    ) -> Result<WorkspaceExecAdmission> {
        self.delegate_workspace_exec_in_context(
            credential,
            &parent.parent,
            &parent.profile,
            (&parent.namespace, &parent.incarnation),
            request_key,
            source,
            lifetime_ms,
        )
        .await
    }
}

impl Store {
    /// A fresh delegation-only issuer after same-process lease refresh. Existing
    /// tool grants and result capabilities retain their original lease/deadline.
    pub async fn authorize_workspace_exec_renewed_parent(
        &self,
        credential: &str,
        renewal: &super::super::RunRenewalAuthority,
        profile: &Arc<WorkspaceExecProfile>,
    ) -> Result<WorkspaceExecParent> {
        let provider = self.renewal_provider(renewal)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        profile.validate(self, &mut tx).await?;
        execution(self, &mut tx, credential, provider).await?;
        let row = self.production_authorized_run(&mut tx, provider).await?;
        if provider.run.role != Role::Worker || row.get::<&str, _>("state") != "running" {
            return Err(RuntimeStoreError::Fenced);
        }
        let c = self.context()?;
        if provider.run.conversation_id != *profile.workspace.exec_identity().2 {
            return Err(RuntimeStoreError::Fenced);
        }
        let result = WorkspaceExecParent {
            profile: profile.clone(),
            parent: Box::new(provider.clone()),
            namespace: c.namespace.clone(),
            incarnation: c.incarnation.clone(),
        };
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}
