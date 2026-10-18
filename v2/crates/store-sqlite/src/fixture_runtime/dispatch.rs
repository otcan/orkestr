use super::admission::{envelope, hash, secret};
use super::*;
use orkestr_v2_application::runtime::*;
use sqlx::sqlite::SqliteRow;

impl FixtureSupervisorStore {
    async fn authorized_run(
        &self,
        conn: &mut SqliteConnection,
        provider: &ProviderAdmission,
    ) -> Result<SqliteRow> {
        self.validate_in(conn).await?;
        if provider.run.owner_id != self.owner {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let row =
            sqlx::query("SELECT * FROM fixture_runs WHERE id=? AND owner_id=? AND context_id=?")
                .bind(provider.run.run_id.to_string())
                .bind(self.owner.to_string())
                .bind(self.context_id.to_string())
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::NotFound)?;
        if row.get::<String, _>("incarnation_id") != self.incarnation_id.to_string() {
            return Err(RuntimeStoreError::Fenced);
        }
        let canonical = envelope(&row)?;
        if canonical.run.lease_generation != provider.run.lease_generation {
            return Err(RuntimeStoreError::StaleLease);
        }
        if canonical.run.dispatch_fence != provider.run.dispatch_fence {
            return Err(RuntimeStoreError::Fenced);
        }
        if canonical != *provider {
            return Err(RuntimeStoreError::Conflict);
        }
        if row.get::<&str, _>("state") != "starting" {
            return Err(RuntimeStoreError::Fenced);
        }
        if canonical.run.lease_deadline_ms <= now(conn).await? {
            return Err(RuntimeStoreError::Expired);
        }
        let binding: i64 = sqlx::query_scalar("SELECT count(*) FROM session_bindings b JOIN fixture_readiness r ON r.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND b.role='deep' AND b.provider_kind='explicit_fixture' AND b.provider_namespace=? AND b.native_session_id=? AND b.generation=? AND b.state='busy' AND r.context_id=? AND r.incarnation_id=? AND r.protocol_version=1")
            .bind(canonical.run.session_id.to_string()).bind(self.owner.to_string()).bind(canonical.run.conversation_id.to_string())
            .bind(&self.namespace).bind(&canonical.run.native_session_id).bind(i64::try_from(canonical.binding.generation).map_err(db)?)
            .bind(self.context_id.to_string()).bind(self.incarnation_id.to_string()).fetch_one(&mut *conn).await.map_err(db)?;
        if binding != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(row)
    }
    pub(super) async fn reserve(
        &self,
        candidate: &RunAdmissionResult,
        request_key: &str,
    ) -> Result<DispatchClaimResult> {
        if !valid(request_key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self
            .store
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        let row = self.authorized_run(&mut tx, &candidate.provider).await?;
        if candidate.run_state != RunState::Starting {
            return Err(RuntimeStoreError::Conflict);
        }
        let state: &str = row.get("dispatch_state");
        if state == "delivery_unknown" || state == "quarantined" {
            return Ok(DispatchClaimResult::ReconciliationRequired);
        }
        if candidate.disposition != AdmissionDisposition::FreshCandidate {
            return Ok(DispatchClaimResult::Replay);
        }
        let key = candidate
            .candidate_key
            .as_deref()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or(RuntimeStoreError::InvalidInput)?;
        if row.get::<Option<String>, _>("candidate_hash")
            != Some(hash("fixture-candidate-v1", &[key]))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        if state == "reserved" {
            if row.get::<Option<String>, _>("reserve_key").as_deref() != Some(request_key) {
                return Err(RuntimeStoreError::Conflict);
            }
            return Ok(DispatchClaimResult::Replay);
        }
        let reservation = secret();
        let changed = sqlx::query("UPDATE fixture_runs SET dispatch_state='reserved',reservation_hash=?,reserve_key=? WHERE id=? AND dispatch_state='candidate'")
            .bind(hash("fixture-reservation-v1", &[&reservation])).bind(request_key).bind(candidate.provider.run.run_id.to_string())
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Conflict);
        }
        #[cfg(test)]
        super::crash_tests::checkpoint("reserve-before-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.fixture_checkpoint("reserve-before-commit").await?;
        tx.commit().await.map_err(db)?;
        #[cfg(test)]
        super::crash_tests::checkpoint("reserve-after-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.fixture_checkpoint("reserve-after-commit").await?;
        Ok(DispatchClaimResult::Reserved(Box::new(DispatchClaim {
            provider: candidate.provider.clone(),
            reservation_key: reservation,
        })))
    }
    pub(super) async fn consume(&self, claim: &DispatchClaim) -> Result<DispatchConsumption> {
        let mut tx = self
            .store
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        let row = self.authorized_run(&mut tx, &claim.provider).await?;
        let state: &str = row.get("dispatch_state");
        if state == "delivery_unknown" || state == "quarantined" {
            return Ok(DispatchConsumption::ReconciliationRequired);
        }
        if state != "reserved" {
            return Err(RuntimeStoreError::Conflict);
        }
        if claim.reservation_key.len() != 64
            || !claim.reservation_key.bytes().all(|b| b.is_ascii_hexdigit())
            || row.get::<Option<String>, _>("reservation_hash")
                != Some(hash("fixture-reservation-v1", &[&claim.reservation_key]))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let changed = sqlx::query("UPDATE fixture_runs SET dispatch_state='delivery_unknown',candidate_hash=NULL,reservation_hash=NULL WHERE id=? AND dispatch_state='reserved'")
            .bind(claim.provider.run.run_id.to_string()).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Ok(DispatchConsumption::ReconciliationRequired);
        }
        #[cfg(test)]
        super::crash_tests::checkpoint("consume-before-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.fixture_checkpoint("consume-before-commit").await?;
        tx.commit().await.map_err(db)?;
        #[cfg(test)]
        super::crash_tests::checkpoint("consume-after-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.fixture_checkpoint("consume-after-commit").await?;
        Ok(DispatchConsumption::DispatchNow)
    }
}
