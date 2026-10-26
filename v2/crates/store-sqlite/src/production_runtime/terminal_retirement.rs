//! Trusted clean shutdown boundary. Native ownership/wait evidence belongs to the
//! server composition; caller-provided PIDs or booleans are never accepted here.
use super::*;
use orkestr_v2_contracts::RunId;

impl Store {
    /// Called only by trusted server teardown AFTER every owned native child is
    /// reaped. This sealed handle can expire only its original live context,
    /// after an exact owner-accepted or canonically Stopped Deep or Fast turn. It grants no dispatch or setup.
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
        let exact: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN production_terminal_evidence a ON a.run_id=r.id JOIN session_bindings b ON b.id=r.session_id JOIN production_readiness rd ON rd.session_id=b.id WHERE r.id=? AND r.owner_id=? AND r.context_id=? AND r.incarnation_id=? AND r.role IN ('deep','fast') AND b.state='ready' AND b.role=r.role AND b.provider_kind=r.provider_kind AND b.native_session_id=r.native_session_id AND b.generation=r.binding_generation+1 AND rd.context_id=r.context_id AND rd.incarnation_id=r.incarnation_id AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation) AND NOT EXISTS(SELECT 1 FROM production_resume_metadata rm WHERE rm.prior_run_id=r.id)")
            .bind(prior_run.to_string()).bind(c.owner.to_string()).bind(&c.id).bind(&c.incarnation)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if exact != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        // A terminal label alone is insufficient: acceptance or a genuine
        // issued-control Stopped acknowledgement must establish its truth.
        let unresolved: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE r.context_id=? AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)")
            .bind(&c.id).fetch_one(&mut *tx).await.map_err(db)?;
        if unresolved != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        if !descendants_clear(&mut tx, &c.id).await? {
            return Err(RuntimeStoreError::Fenced);
        }
        super::fast_continuity::retire_failed_setups(&mut tx, &c.id, &c.incarnation).await?;
        // Immutable provenance is issued only after the canonical terminal checks
        // above. Other expiry/revocation paths must never create this evidence.
        let clock = now(&mut tx).await?;
        let deadline: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms FROM production_supervisors WHERE context_id=?",
        )
        .bind(&c.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let existing: i64 = sqlx::query_scalar("SELECT count(*) FROM production_retirement_provenance WHERE context_id=? AND incarnation_id=? AND supervisor_generation=? AND prior_run_id=?")
            .bind(&c.id).bind(&c.incarnation).bind(c.generation).bind(prior_run.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if deadline <= clock && !(deadline == 0 && existing == 1) {
            return Err(RuntimeStoreError::Expired);
        }
        for (table, column, kind) in [
            (
                "production_graceful_retirements",
                "acceptance_event_id",
                "accepted",
            ),
            (
                "production_stopped_retirements",
                "stopped_event_id",
                "stopped",
            ),
        ] {
            // All SQL identifiers are closed constants above, never caller data.
            sqlx::query(&format!("INSERT INTO {table}(context_id,incarnation_id,supervisor_generation,prior_run_id,{column},session_id,binding_generation,retired_at_ms) SELECT r.context_id,r.incarnation_id,?,r.id,a.event_id,r.session_id,b.generation,? FROM production_runs r JOIN production_terminal_evidence a ON a.run_id=r.id JOIN session_bindings b ON b.id=r.session_id WHERE r.id=? AND a.terminal_kind=? ON CONFLICT(context_id,incarnation_id,supervisor_generation) DO NOTHING"))
                .bind(c.generation).bind(clock).bind(prior_run.to_string()).bind(kind)
                .execute(&mut *tx).await.map_err(db)?;
        }
        let recorded: i64 = sqlx::query_scalar("SELECT count(*) FROM production_retirement_provenance g JOIN production_runs r ON r.id=g.prior_run_id JOIN production_terminal_evidence a ON a.run_id=r.id JOIN session_bindings b ON b.id=r.session_id WHERE g.context_id=? AND g.incarnation_id=? AND g.supervisor_generation=? AND g.prior_run_id=? AND g.terminal_event_id=a.event_id AND g.session_id=r.session_id AND g.binding_generation=b.generation")
            .bind(&c.id).bind(&c.incarnation).bind(c.generation).bind(prior_run.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if recorded != 1 {
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

#[cfg(test)]
mod stopped_tests;

mod descendants;
pub(super) use descendants::descendants_clear;
#[cfg(test)]
mod descendant_tests;

#[cfg(test)]
mod descendant_effect_tests;
