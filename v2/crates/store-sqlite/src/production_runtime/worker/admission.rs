use super::*;
use crate::runtime::ledger::{hash, secret};
use sqlx::sqlite::SqliteRow;
impl Store {
    /// Consumes a distinct server-issued Worker delegation, never an InboxClaim.
    pub async fn admit_worker(
        &self,
        credential: &str,
        delegation: WorkerDelegation,
    ) -> Result<RunAdmissionResult> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let d=sqlx::query("SELECT * FROM worker_provider_delegations WHERE id=? AND owner_id=? AND context_id=? AND incarnation_id=?")
            .bind(delegation.id().to_string()).bind(c.owner.to_string()).bind(&c.id).bind(&c.incarnation)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        if d.get::<&str, _>("state") != "delegated" {
            return Err(RuntimeStoreError::Fenced);
        }
        if d.get::<Option<String>, _>("grant_hash")
            != Some(hash("worker-provider-grant-v1", &[&delegation._locator]))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        self.worker_delegation_parent_in(&mut tx, &d, false).await?;
        let clock = now(&mut tx).await?;
        let deadline: i64 = d.get("expires_at_ms");
        if deadline <= clock {
            return Err(RuntimeStoreError::Expired);
        }
        let b=sqlx::query("SELECT b.* FROM session_bindings b JOIN production_readiness r ON r.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND b.provider_kind=? AND b.provider_namespace=? AND r.context_id=? AND r.incarnation_id=?")
            .bind(d.get::<&str,_>("worker_session_id")).bind(c.owner.to_string()).bind(d.get::<&str,_>("conversation_id"))
            .bind(provider_name(c.provider)?).bind(&c.namespace).bind(&c.id).bind(&c.incarnation)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Unavailable)?;
        if b.get::<&str, _>("role") != "worker"
            || b.get::<Option<String>, _>("parent_session_id").as_deref()
                != Some(d.get::<&str, _>("parent_session_id"))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        if b.get::<i64, _>("generation") != d.get::<i64, _>("worker_binding_generation") {
            return Err(RuntimeStoreError::StaleLease);
        }
        if b.get::<&str, _>("state") != "ready" {
            return Err(RuntimeStoreError::Busy);
        }
        let occupied:i64=sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE session_id=? AND state NOT IN ('cancelled','succeeded')")
            .bind(d.get::<&str,_>("worker_session_id")).fetch_one(&mut *tx).await.map_err(db)?;
        if occupied != 0 {
            return Err(RuntimeStoreError::Busy);
        }
        let native: String = b
            .get::<Option<String>, _>("native_session_id")
            .ok_or(RuntimeStoreError::Unavailable)?;
        let sequence:i64=sqlx::query_scalar("SELECT sequence FROM events WHERE id=? AND message_id=? AND owner_id=? AND conversation_id=? AND kind='message_accepted'")
            .bind(d.get::<&str,_>("source_event_id")).bind(d.get::<&str,_>("source_message_id"))
            .bind(c.owner.to_string()).bind(d.get::<&str,_>("conversation_id"))
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Conflict)?;
        let id = Uuid::new_v4();
        let candidate = secret();
        let row=sqlx::query("INSERT INTO production_runs(id,context_id,incarnation_id,owner_id,conversation_id,session_id,native_session_id,provider_kind,binding_generation,message_id,event_id,scope_sequence,claim_generation,request_key,input_digest,lease_generation,dispatch_fence,lease_deadline_ms,attempt,state,dispatch_state,candidate_hash,role,parent_session_id,worker_delegation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,1,?,?,1,'starting','candidate',?,'worker',?,?) RETURNING *")
            .bind(id.to_string()).bind(&c.id).bind(&c.incarnation).bind(c.owner.to_string()).bind(d.get::<&str,_>("conversation_id"))
            .bind(d.get::<&str,_>("worker_session_id")).bind(native).bind(provider_name(c.provider)?).bind(d.get::<i64,_>("worker_binding_generation"))
            .bind(d.get::<&str,_>("source_message_id")).bind(d.get::<&str,_>("source_event_id")).bind(sequence)
            .bind(format!("worker:{}",delegation.id())).bind(d.get::<&str,_>("input_digest"))
            .bind(c.generation).bind(deadline).bind(hash("production-candidate-v1",&[&candidate]))
            .bind(d.get::<&str,_>("parent_session_id")).bind(delegation.id().to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO production_run_leases(run_id,generation,lease_deadline_ms,dispatch_fence) VALUES(?,1,?,?)")
            .bind(id.to_string()).bind(deadline).bind(c.generation).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("UPDATE session_bindings SET state='busy' WHERE id=?")
            .bind(d.get::<&str, _>("worker_session_id"))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("UPDATE worker_provider_delegations SET state='admitted',grant_hash=NULL,admitted_run_id=? WHERE id=?")
            .bind(id.to_string()).bind(delegation.id().to_string()).execute(&mut *tx).await.map_err(db)?;
        let result = RunAdmissionResult {
            provider: super::super::admission::envelope(&row)?,
            run_state: RunState::Starting,
            disposition: AdmissionDisposition::FreshCandidate,
            candidate_key: Some(candidate),
        };
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("admit-before-commit").await?;
        tx.commit().await.map_err(db)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("admit-after-commit").await?;
        Ok(result)
    }
    pub(in crate::production_runtime) async fn worker_lineage_in(
        &self,
        conn: &mut SqliteConnection,
        run: &SqliteRow,
    ) -> Result<()> {
        let d=sqlx::query("SELECT * FROM worker_provider_delegations WHERE id=? AND admitted_run_id=? AND state='admitted'")
            .bind(run.get::<&str,_>("worker_delegation_id")).bind(run.get::<&str,_>("id"))
            .fetch_optional(&mut *conn).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        if d.get::<&str, _>("worker_session_id") != run.get::<&str, _>("session_id")
            || d.get::<&str, _>("parent_session_id") != run.get::<&str, _>("parent_session_id")
            || d.get::<&str, _>("source_message_id") != run.get::<&str, _>("message_id")
            || d.get::<&str, _>("source_event_id") != run.get::<&str, _>("event_id")
            || d.get::<i64, _>("expires_at_ms") < run.get::<i64, _>("lease_deadline_ms")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        if d.get::<i64, _>("expires_at_ms") <= now(conn).await? {
            return Err(RuntimeStoreError::Expired);
        }
        self.worker_delegation_parent_in(
            conn,
            &d,
            run.get::<&str, _>("dispatch_state") == "delivery_unknown",
        )
        .await
    }
    async fn worker_delegation_parent_in(
        &self,
        conn: &mut SqliteConnection,
        d: &SqliteRow,
        retained: bool,
    ) -> Result<()> {
        let c = self.context()?;
        if d.get::<&str, _>("owner_id") != c.owner.to_string()
            || d.get::<&str, _>("context_id") != c.id
            || d.get::<&str, _>("incarnation_id") != c.incarnation
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let parent=sqlx::query("SELECT * FROM production_runs WHERE id=? AND context_id=? AND incarnation_id=? AND owner_id=? AND conversation_id=? AND role='deep' AND dispatch_state='delivery_unknown'")
            .bind(d.get::<&str,_>("parent_run_id")).bind(&c.id).bind(&c.incarnation).bind(c.owner.to_string()).bind(d.get::<&str,_>("conversation_id"))
            .fetch_optional(&mut *conn).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        for (parent_field, delegation_field) in [
            ("binding_generation", "parent_binding_generation"),
            ("lease_generation", "parent_lease_generation"),
            ("dispatch_fence", "parent_dispatch_fence"),
            ("lease_deadline_ms", "parent_deadline_ms"),
        ] {
            if parent.get::<i64, _>(parent_field) != d.get::<i64, _>(delegation_field) {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        if parent.get::<&str, _>("session_id") != d.get::<&str, _>("parent_session_id")
            || parent.get::<&str, _>("message_id") != d.get::<&str, _>("source_message_id")
            || parent.get::<&str, _>("event_id") != d.get::<&str, _>("source_event_id")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        if retained && parent.get::<&str, _>("state") == "awaiting_acceptance" {
            return self.worker_proposal_parent_in(conn, &parent).await;
        }
        if parent.get::<&str, _>("state") != "running" {
            return Err(RuntimeStoreError::Fenced);
        }
        let canonical = super::super::admission::envelope(&parent)?;
        Box::pin(self.production_authorized_run(conn, &canonical)).await?;
        Ok(())
    }
}
