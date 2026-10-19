//! Original Worker cleanup evidence gates a stopped parent's metadata-only resume.
use super::*;
use orkestr_runtime::containment::ReapedBroker;
use orkestr_v2_contracts::RunId;

impl ConfiguredExecution {
    pub(super) async fn worker_stopped_grant(
        &self,
        run: &RunId,
        proof: ReapedBroker,
    ) -> Result<BoundSessionMetadata, &'static str> {
        if self.config.worker.is_none() {
            return Err("Worker stopped continuation policy unavailable");
        }
        // Drain has already collected each original witness. This additional
        // resource barrier alone can never authorize metadata or new inference.
        if !self.children.wait_empty(Duration::from_secs(2)).await {
            return Err("execution retained child resources remain active");
        }
        self.current().await?;
        let binding = self
            .store
            .ensure_role_bindings(&self.owner, &self.config.conversation_id)
            .await
            .map_err(|_| "execution stopped binding unavailable")?
            .deep;
        self.worker_reaps
            .stopped_metadata(&self.store, &self.token, run, proof, &binding)
            .await
    }
}
