//! Independent provider Worker authority, distinct from subordinate tool grants.
//! Delegation and admission explicitly refuse until durable lineage guards are
//! installed; the trusted parent locator is resolved inside the Store transaction.
use super::*;
use orkestr_v2_contracts::{ConversationId, EventId, MessageId, RunId, SessionId};
mod parent;
mod types;
pub use types::*;
#[cfg(test)]
mod tests;

impl Store {
    /// Source-stable seam for trusted server composition. This method never
    /// returns a grant until the Worker ledger and descendant fences are present.
    pub async fn delegate_worker(
        &self,
        credential: &str,
        parent_run_id: &RunId,
        _input: &WorkerAdmissionInput,
    ) -> Result<WorkerDelegationResult> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.worker_parent_in(&mut tx, credential, parent_run_id)
            .await?;
        Err(RuntimeStoreError::Unavailable)
    }

    /// No Worker inference authority is manufactured by this unimplemented port.
    pub async fn admit_worker(
        &self,
        credential: &str,
        _delegation: WorkerDelegation,
    ) -> Result<RunAdmissionResult> {
        self.worker_credential(credential)?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        self.context()?.validate(&mut tx).await?;
        Err(RuntimeStoreError::Unavailable)
    }
}
