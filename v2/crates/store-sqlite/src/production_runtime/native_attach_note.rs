//! Whether a Deep run is the first one after the owner worked in its native
//! session from a terminal (`orkestr attach`). The server reads when that
//! attach ended from a Root record; Core answers from its own run evidence
//! and records nothing. While a hold is active no Deep run starts, so the
//! first writer run after the attach is the one no other recent writer run
//! of the conversation precedes with provider evidence since the attach ended.
use super::*;
use orkestr_v2_contracts::RunId;

/// The latest writer Deep runs (by input order) that are compared.
const RECENT_RUNS: i64 = 8;

impl Store {
    /// `true` when no other recent writer (slot 0) Deep run of `run`'s
    /// conversation has a provider observation at or after `since_ms`.
    pub async fn first_deep_run_since(&self, run: &RunId, since_ms: i64) -> Result<bool> {
        let c = self.context()?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        c.authenticate(&mut tx).await?;
        let own: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE id=? AND owner_id=? AND role='deep' AND deep_slot=0")
            .bind(run.to_string()).bind(c.owner.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if own != 1 {
            return Err(RuntimeStoreError::NotFound);
        }
        let later: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM (SELECT p.id FROM production_runs p JOIN production_runs c ON c.id=? AND p.conversation_id=c.conversation_id AND p.owner_id=c.owner_id WHERE p.role='deep' AND p.deep_slot=0 AND p.id<>c.id ORDER BY p.scope_sequence DESC LIMIT ?) recent JOIN production_observations o ON o.run_id=recent.id JOIN events e ON e.id=o.event_id WHERE (julianday(e.occurred_at)-2440587.5)*86400000.0>=?)")
            .bind(run.to_string()).bind(RECENT_RUNS).bind(since_ms)
            .fetch_one(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(later == 0)
    }
}
