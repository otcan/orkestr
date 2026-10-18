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
        let (generation, deadline) = super::leases::current(conn, &provider.run.run_id).await?;
        if generation != provider.run.lease_generation {
            return Err(RuntimeStoreError::StaleLease);
        }
        if canonical.run.dispatch_fence != provider.run.dispatch_fence {
            return Err(RuntimeStoreError::Fenced);
        }
        super::leases::authenticate(conn, &row, provider).await?;
        if row.get::<&str, _>("state") != "starting" {
            return Err(RuntimeStoreError::Fenced);
        }
        if deadline <= now(conn).await? {
            return Err(RuntimeStoreError::Expired);
        }
        self.ready_in(conn, provider).await?;
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
        crate::runtime::ledger::reserve(
            &mut tx,
            crate::runtime::ledger::Ledger::Fixture,
            &candidate.provider.run.run_id.to_string(),
            &hash("fixture-reservation-v1", &[&reservation]),
            request_key,
        )
        .await?;
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
        if !crate::runtime::ledger::consume(
            &mut tx,
            crate::runtime::ledger::Ledger::Fixture,
            &claim.provider.run.run_id.to_string(),
        )
        .await?
        {
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
