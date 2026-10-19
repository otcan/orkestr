//! Negative authority only: an existing sealed handle may retire its own revoked
//! credential's unresolved work. This never issues a replacement control token.
use super::*;

impl Store {
    /// Trusted supervisor teardown after its original machine session is revoked
    /// or expired. No caller-supplied identity or credential can widen this scope.
    /// Returns the number of newly blocked runs; repeating retirement is harmless.
    pub async fn retire_revoked_supervisor(&self) -> Result<u64> {
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let live: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(&c.token_hash).bind(c.owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if live != 0 {
            return Err(RuntimeStoreError::Busy);
        }
        // Do not authenticate positively: absence of this exact original session
        // is the condition being proved. Still require the sealed current context.
        let current: i64 = sqlx::query_scalar("SELECT count(*) FROM production_supervisors WHERE context_id=? AND owner_id=? AND provider_kind=? AND namespace=? AND supervisor_key=? AND incarnation_id=? AND generation=?")
            .bind(&c.id).bind(c.owner.to_string()).bind(provider_name(c.provider)?)
            .bind(&c.namespace).bind(&c.key).bind(&c.incarnation).bind(c.generation)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if current != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("UPDATE session_bindings SET state='lost' WHERE owner_id=? AND id IN (SELECT session_id FROM production_runs WHERE context_id=? AND incarnation_id=? AND owner_id=? AND state IN ('starting','running','cancel_requested'))")
            .bind(c.owner.to_string()).bind(&c.id).bind(&c.incarnation).bind(c.owner.to_string())
            .execute(&mut *tx).await.map_err(db)?;
        let changed = sqlx::query("UPDATE production_runs SET state='blocked',dispatch_state=CASE WHEN dispatch_state='delivery_unknown' THEN 'delivery_unknown' ELSE 'quarantined' END,candidate_hash=NULL,reservation_hash=NULL,reserve_key=NULL WHERE context_id=? AND incarnation_id=? AND owner_id=? AND state IN ('starting','running','cancel_requested')")
            .bind(&c.id).bind(&c.incarnation).bind(c.owner.to_string())
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        // Expire metadata/bootstrap authority too, without changing incarnation or
        // fabricating a successor. A later takeover still needs fresh auth + CAS.
        sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0 WHERE context_id=? AND incarnation_id=? AND generation=? AND lease_deadline_ms!=0")
            .bind(&c.id).bind(&c.incarnation).bind(c.generation).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(changed)
    }
}
