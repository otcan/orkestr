//! Proven gracefully retired supervisor restart, never recovery of an uncertain turn.
use super::*;
use orkestr_v2_contracts::{ConversationId, RunId};

impl Store {
    /// Trusted server discovery only. Returned IDs are locators, not authority;
    /// reattach revalidates every predicate and exact predecessor under write lock.
    /// No credential, native identity or setup reservation is returned here.
    pub async fn terminal_supervisor_candidate(
        &self,
        credential: &str,
        config: &ProductionSupervisorConfig,
        conversation: &ConversationId,
    ) -> Result<Option<(RunId, String)>> {
        if credential.len() != 64 || !credential.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if !valid(&config.namespace) || !valid(&config.supervisor_key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner: String = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Unauthorized)?;
        let candidate = sqlx::query("SELECT r.id,s.incarnation_id FROM production_supervisors s JOIN production_runs r ON r.context_id=s.context_id AND r.incarnation_id=s.incarnation_id JOIN production_acceptances a ON a.run_id=r.id JOIN session_bindings b ON b.id=r.session_id JOIN production_graceful_retirements g ON g.context_id=s.context_id AND g.incarnation_id=s.incarnation_id AND g.supervisor_generation=s.generation AND g.prior_run_id=r.id AND g.acceptance_event_id=a.event_id AND g.session_id=b.id AND g.binding_generation=b.generation WHERE s.lease_deadline_ms=0 AND s.owner_id=? AND s.provider_kind=? AND s.namespace=? AND s.supervisor_key=? AND r.conversation_id=? AND r.role IN ('deep','fast') AND r.state='succeeded' AND b.state='ready' AND b.generation=r.binding_generation+1 AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.context_id=s.context_id AND other.state NOT IN ('succeeded','cancelled')) AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation) AND NOT EXISTS(SELECT 1 FROM production_resume_metadata rm WHERE rm.prior_run_id=r.id)")
            .bind(owner).bind(provider_name(config.provider)?).bind(&config.namespace).bind(&config.supervisor_key).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let result = candidate
            .map(|row| -> Result<_> {
                Ok((
                    RunId(row.get::<String, _>("id").parse().map_err(db)?),
                    row.get("incarnation_id"),
                ))
            })
            .transpose()?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
    /// Trusted configured restart after an owner-accepted Deep or Fast turn. Requires
    /// exact expired predecessor CAS and returns a single setup reservation in
    /// the same transaction. The server must prove its old owned child reaped.
    /// No historical run or consumed dispatch is reissued; queued input remains.
    pub async fn reattach_terminal_supervisor(
        &self,
        credential: &str,
        config: ProductionSupervisorConfig,
        prior_run: &RunId,
    ) -> Result<(Store, BoundSessionMetadata)> {
        if credential.len() != 64 || !credential.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let ProductionTakeover::ExpiredPredecessor { incarnation_id } = config.takeover else {
            return Err(RuntimeStoreError::InvalidInput);
        };
        let provider = provider_name(config.provider)?;
        if !valid(&config.namespace) || !valid(&config.supervisor_key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let token_hash = crate::digest(credential);
        let owner: String = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(&token_hash)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Unauthorized)?;
        let row = sqlx::query("SELECT * FROM production_supervisors WHERE owner_id=? AND provider_kind=? AND namespace=? AND supervisor_key=?")
            .bind(&owner).bind(provider).bind(&config.namespace).bind(&config.supervisor_key)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        if row.get::<String, _>("incarnation_id") != incarnation_id {
            return Err(RuntimeStoreError::Conflict);
        }
        let clock = now(&mut tx).await?;
        if row.get::<i64, _>("lease_deadline_ms") > clock {
            return Err(RuntimeStoreError::Busy);
        }
        let context_id: String = row.get("context_id");
        // Natural expiry, revoked retirement and legacy deadline zero are not
        // graceful evidence. Match the immutable original decision before CAS.
        let graceful: i64 = sqlx::query_scalar("SELECT count(*) FROM production_graceful_retirements g JOIN production_runs r ON r.id=g.prior_run_id JOIN production_acceptances a ON a.run_id=r.id JOIN session_bindings b ON b.id=r.session_id WHERE g.context_id=? AND g.incarnation_id=? AND g.supervisor_generation=? AND g.prior_run_id=? AND g.acceptance_event_id=a.event_id AND g.session_id=r.session_id AND g.binding_generation=b.generation")
            .bind(&context_id).bind(&incarnation_id).bind(row.get::<i64,_>("generation"))
            .bind(prior_run.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if row.get::<i64, _>("lease_deadline_ms") != 0 || graceful != 1 {
            return Err(RuntimeStoreError::Fenced);
        }

        // Clean means no unresolved run anywhere in this supervisor namespace,
        // including children. Do not convert unknown delivery into a new attempt.
        let unresolved: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE context_id=? AND state NOT IN ('succeeded','cancelled')")
            .bind(&context_id).fetch_one(&mut *tx).await.map_err(db)?;
        if unresolved != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        let terminal = sqlx::query("SELECT r.session_id,a.event_id FROM production_runs r JOIN production_acceptances a ON a.run_id=r.id WHERE r.id=? AND r.owner_id=? AND r.context_id=? AND r.incarnation_id=? AND r.role IN ('deep','fast') AND r.state='succeeded'")
            .bind(prior_run.to_string()).bind(&owner).bind(&context_id).bind(&incarnation_id)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        let session: String = terminal.get("session_id");
        let binding = sqlx::query(
            "SELECT * FROM session_bindings WHERE id=? AND owner_id=? AND provider_namespace=?",
        )
        .bind(&session)
        .bind(&owner)
        .bind(&config.namespace)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let binding = crate::runtime::binding(&binding)?;
        let generation = row
            .get::<i64, _>("generation")
            .checked_add(1)
            .ok_or(RuntimeStoreError::Unavailable)?;
        let incarnation = Uuid::new_v4().to_string();
        sqlx::query("UPDATE production_supervisors SET incarnation_id=?,generation=?,lease_deadline_ms=? WHERE context_id=?")
            .bind(&incarnation).bind(generation).bind(clock+60_000).bind(&context_id).execute(&mut *tx).await.map_err(db)?;
        let changed = sqlx::query("UPDATE production_readiness SET incarnation_id=? WHERE context_id=? AND incarnation_id=? AND session_id=?")
            .bind(&incarnation).bind(&context_id).bind(&incarnation_id).bind(&session).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        // Other old setup bindings cannot be used as if their process survived.
        sqlx::query("UPDATE session_bindings SET state='lost' WHERE id!=? AND id IN (SELECT session_id FROM production_readiness WHERE context_id=?)")
            .bind(&session).bind(&context_id).execute(&mut *tx).await.map_err(db)?;
        let store = Store {
            #[cfg(feature = "fixture-test-controls")]
            production_checkpoint: None,
            pool: self.pool.clone(),
            authority: Some(Context {
                owner: OwnerId(owner.parse().map_err(db)?),
                provider: config.provider,
                namespace: config.namespace,
                key: config.supervisor_key,
                id: context_id,
                incarnation,
                generation,
                token_hash,
            }),
        };
        let grant = store
            .reserve_terminal_metadata(tx, prior_run, &binding, terminal.get("event_id"))
            .await?;
        Ok((store, grant))
    }
}
#[cfg(test)]
mod tests;
