//! Trusted clean shutdown boundary. Native ownership/wait evidence belongs to the
//! server composition; caller-provided PIDs or booleans are never accepted here.
use super::*;
use orkestr_v2_contracts::RunId;

impl Store {
    /// Called only by trusted server teardown AFTER every owned native child is
    /// reaped. This sealed handle can expire only its original live context,
    /// after an exact owner-accepted Deep turn. It grants no dispatch or setup.
    /// A configured restart still needs the exact predecessor CAS in
    /// `reattach_terminal_supervisor`. Unknown/ACK-only work refuses unchanged.
    pub async fn retire_terminal_supervisor(
        &self,
        credential: &str,
        prior_run: &RunId,
    ) -> Result<()> {
        let c = self.context()?;
        if credential.len() != 64
            || !credential.bytes().all(|b| b.is_ascii_hexdigit())
            || crate::digest(credential) != c.token_hash
        {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.authenticate(&mut tx).await?;
        // Deliberately permit repeated retirement after our own deadline became
        // zero, but never accept another incarnation or credential as ours.
        let current: i64 = sqlx::query_scalar("SELECT count(*) FROM production_supervisors WHERE context_id=? AND owner_id=? AND provider_kind=? AND namespace=? AND supervisor_key=? AND incarnation_id=? AND generation=?")
            .bind(&c.id).bind(c.owner.to_string()).bind(provider_name(c.provider)?)
            .bind(&c.namespace).bind(&c.key).bind(&c.incarnation).bind(c.generation)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if current != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        let exact: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN production_acceptances a ON a.run_id=r.id JOIN session_bindings b ON b.id=r.session_id JOIN production_readiness rd ON rd.session_id=b.id WHERE r.id=? AND r.owner_id=? AND r.context_id=? AND r.incarnation_id=? AND r.role='deep' AND r.state='succeeded' AND b.state='ready' AND b.generation=r.binding_generation+1 AND rd.context_id=r.context_id AND rd.incarnation_id=r.incarnation_id AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation) AND NOT EXISTS(SELECT 1 FROM production_resume_metadata rm WHERE rm.prior_run_id=r.id)")
            .bind(prior_run.to_string()).bind(c.owner.to_string()).bind(&c.id).bind(&c.incarnation)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if exact != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        // A terminal label alone is insufficient: acceptance or a genuine
        // issued-control Stopped acknowledgement must establish its truth.
        let unresolved: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE r.context_id=? AND NOT ((r.state='succeeded' AND EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id)) OR (r.state='cancelled' AND EXISTS(SELECT 1 FROM production_observations o JOIN production_control_outbox co ON co.run_id=o.run_id WHERE o.run_id=r.id AND o.kind='stopped' AND co.state='acknowledged')))")
            .bind(&c.id).fetch_one(&mut *tx).await.map_err(db)?;
        if unresolved != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0 WHERE context_id=? AND incarnation_id=? AND generation=?")
            .bind(&c.id).bind(&c.incarnation).bind(c.generation).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}
#[cfg(test)]
mod tests;
