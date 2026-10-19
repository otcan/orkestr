//! Setup-only continuation after a canonical confirmed Stop, never unknown delivery.
use super::*;
use orkestr_v2_contracts::RunId;

impl Store {
    /// Reserve metadata setup once after exact issued cancellation control produced
    /// a durable Stopped observation. The caller must first fully reap its child.
    /// ACK-only, NotDispatched and unknown outcomes do not qualify.
    pub async fn authorize_stopped_session_metadata(
        &self,
        credential: &str,
        prior_run: &RunId,
        binding: &Binding,
    ) -> Result<BoundSessionMetadata> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let terminal: String = sqlx::query_scalar("SELECT o.event_id FROM production_observations o JOIN production_runs r ON r.id=o.run_id WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND o.kind='stopped' AND o.receipt_state='cancelled'")
            .bind(prior_run.to_string()).bind(c.owner.to_string()).bind(binding.conversation_id.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        self.reserve_terminal_metadata(tx, prior_run, binding, terminal)
            .await
    }
}
#[cfg(test)]
mod descendant_tests;
#[cfg(test)]
mod tests;
