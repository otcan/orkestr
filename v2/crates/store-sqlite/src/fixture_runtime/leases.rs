//! Bounded execution renewal. Historical tokens authenticate receipts, never new work.
use super::admission::envelope;
use super::*;
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::RunId;
use sqlx::sqlite::SqliteRow;

pub(super) async fn current(conn: &mut SqliteConnection, run: &RunId) -> Result<(u64, i64)> {
    let row = sqlx::query("SELECT generation,lease_deadline_ms FROM fixture_run_leases WHERE run_id=? ORDER BY generation DESC LIMIT 1")
        .bind(run.to_string()).fetch_one(conn).await.map_err(db)?;
    Ok((
        u64::try_from(row.get::<i64, _>("generation")).map_err(db)?,
        row.get("lease_deadline_ms"),
    ))
}

/// Full immutable association and exact store-issued mutable token. Never accepts
/// an arbitrary old deadline/generation merely because a run ID is known.
pub(super) async fn authenticate(
    conn: &mut SqliteConnection,
    row: &SqliteRow,
    provider: &ProviderAdmission,
) -> Result<()> {
    let mut expected = envelope(row)?;
    expected.run.lease_generation = provider.run.lease_generation;
    expected.run.lease_deadline_ms = provider.run.lease_deadline_ms;
    expected.run.dispatch_fence = provider.run.dispatch_fence;
    expected.run.purpose = provider.run.purpose;
    if expected != *provider {
        return Err(RuntimeStoreError::Conflict);
    }
    let issued: i64 = sqlx::query_scalar("SELECT count(*) FROM fixture_run_leases WHERE run_id=? AND generation=? AND lease_deadline_ms=? AND dispatch_fence=? AND purpose=?")
        .bind(provider.run.run_id.to_string())
        .bind(i64::try_from(provider.run.lease_generation).map_err(|_|RuntimeStoreError::InvalidInput)?)
        .bind(provider.run.lease_deadline_ms)
        .bind(i64::try_from(provider.run.dispatch_fence).map_err(|_|RuntimeStoreError::InvalidInput)?)
        .bind(match provider.run.purpose { AdmissionPurpose::Execution => "execution", AdmissionPurpose::CancellationAcknowledgement => "cancellation_acknowledgement" })
        .fetch_one(conn).await.map_err(db)?;
    if issued != 1 {
        return Err(RuntimeStoreError::Conflict);
    }
    Ok(())
}

impl FixtureSupervisorStore {
    pub(super) async fn ready_in(
        &self,
        conn: &mut SqliteConnection,
        p: &ProviderAdmission,
    ) -> Result<()> {
        let ready: i64 = sqlx::query_scalar("SELECT count(*) FROM session_bindings b JOIN fixture_readiness r ON r.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND b.role='deep' AND b.state='busy' AND b.generation=? AND b.provider_kind='explicit_fixture' AND b.provider_namespace=? AND b.native_session_id=? AND r.context_id=? AND r.incarnation_id=? AND r.protocol_version=1")
            .bind(p.run.session_id.to_string()).bind(self.owner.to_string()).bind(p.run.conversation_id.to_string())
            .bind(i64::try_from(p.binding.generation).map_err(db)?).bind(&self.namespace).bind(&p.run.native_session_id)
            .bind(self.context_id.to_string()).bind(self.incarnation_id.to_string()).fetch_one(conn).await.map_err(db)?;
        if ready != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
    pub(super) async fn renew(
        &self,
        admission: &RunAdmission,
        expected_generation: u64,
    ) -> Result<RunAdmission> {
        if admission.owner_id != self.owner {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if admission.purpose != AdmissionPurpose::Execution {
            return Err(RuntimeStoreError::Fenced);
        }
        if expected_generation == 0
            || expected_generation > i64::MAX as u64
            || admission.lease_generation == 0
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self
            .store
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        self.validate_in(&mut tx).await?;
        let row =
            sqlx::query("SELECT * FROM fixture_runs WHERE id=? AND owner_id=? AND context_id=?")
                .bind(admission.run_id.to_string())
                .bind(self.owner.to_string())
                .bind(self.context_id.to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::NotFound)?;
        if row.get::<String, _>("incarnation_id") != self.incarnation_id.to_string() {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut provider = envelope(&row)?;
        if provider.run.dispatch_fence != admission.dispatch_fence {
            return Err(RuntimeStoreError::Fenced);
        }
        let (generation, deadline) = current(&mut tx, &admission.run_id).await?;
        if generation != expected_generation || generation != admission.lease_generation {
            return Err(RuntimeStoreError::StaleLease);
        }
        provider.run = admission.clone();
        authenticate(&mut tx, &row, &provider).await?;
        let clock = now(&mut tx).await?;
        if deadline <= clock {
            return Err(RuntimeStoreError::Expired);
        }
        if !matches!(row.get::<&str, _>("state"), "starting" | "running")
            || row.get::<&str, _>("dispatch_state") == "quarantined"
        {
            return Err(RuntimeStoreError::Fenced);
        }
        self.ready_in(&mut tx, &provider).await?;
        let supervisor_deadline: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms FROM fixture_supervisors WHERE context_id=?",
        )
        .bind(self.context_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let extended = clock
            .checked_add(LEASE_MS)
            .ok_or(RuntimeStoreError::Unavailable)?
            .min(supervisor_deadline);
        // Renewal never extends supervisor authority or spends a generation for no extension.
        if extended <= deadline {
            return Err(RuntimeStoreError::Busy);
        }
        let next = generation
            .checked_add(1)
            .filter(|g| *g <= i64::MAX as u64)
            .ok_or(RuntimeStoreError::Unavailable)?;
        sqlx::query(
            "INSERT INTO fixture_run_leases(run_id,generation,lease_deadline_ms,dispatch_fence) VALUES(?,?,?,?)",
        )
        .bind(admission.run_id.to_string())
        .bind(next as i64)
        .bind(extended)
        .bind(i64::try_from(admission.dispatch_fence).map_err(db)?)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        provider.run.lease_generation = next;
        provider.run.lease_deadline_ms = extended;
        tx.commit().await.map_err(db)?;
        Ok(provider.run)
    }
}
