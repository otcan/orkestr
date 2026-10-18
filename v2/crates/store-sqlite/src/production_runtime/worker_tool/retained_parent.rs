use super::*;

/// Delegation lineage retained before inference consumption. No inference,
/// tool launch or result-delivery authority is exposed by this handle.
pub struct OfflinePythonParent {
    pub(super) parent: Box<ProviderAdmission>,
    pub(super) namespace: String,
    pub(super) incarnation: String,
}

impl Store {
    pub async fn authorize_offline_python_parent(
        &self,
        credential: &str,
        consumed: &ConsumedProviderDispatch,
    ) -> Result<OfflinePythonParent> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        execution(self, &mut tx, credential, consumed.provider()).await?;
        let c = self.context()?;
        if consumed.provider().run.role != Role::Worker
            || consumed.namespace() != c.namespace
            || consumed.incarnation_id() != c.incarnation
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let parent = OfflinePythonParent {
            parent: Box::new(consumed.provider().clone()),
            namespace: c.namespace.clone(),
            incarnation: c.incarnation.clone(),
        };
        tx.commit().await.map_err(db)?;
        Ok(parent)
    }

    /// A validated native request supplies input, never authority. This retained
    /// handle and current credential are revalidated before replay or delegation.
    pub async fn delegate_offline_python_from_parent(
        &self,
        credential: &str,
        parent: &OfflinePythonParent,
        request_key: &str,
        source: &str,
        lifetime_ms: u32,
    ) -> Result<OfflinePythonAdmission> {
        self.delegate_offline_python_in_context(
            credential,
            &parent.parent,
            (&parent.namespace, &parent.incarnation),
            request_key,
            source,
            lifetime_ms,
        )
        .await
    }
}
