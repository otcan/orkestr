//! Store-clock bounds; renewal never changes provider identity or dispatch purpose.
use super::admission::envelope;
use super::*;

impl Store {
    /// Only an already live, machine-authenticated bound handle can heartbeat.
    /// Expired contexts require predecessor-CAS takeover, never revival here.
    pub async fn heartbeat_supervisor(&self) -> Result<i64> {
        let context = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        context.validate(&mut tx).await?;
        let deadline = now(&mut tx)
            .await?
            .checked_add(60_000)
            .ok_or(RuntimeStoreError::Unavailable)?;
        sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=? WHERE context_id=? AND incarnation_id=? AND generation=?")
            .bind(deadline).bind(&context.id).bind(&context.incarnation).bind(context.generation)
            .execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(deadline)
    }

    pub(crate) async fn production_renew(
        &self,
        admission: &RunAdmission,
        expected_generation: u64,
    ) -> Result<RunAdmission> {
        let context = self.context()?;
        if admission.owner_id != context.owner {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if admission.purpose != AdmissionPurpose::Execution {
            return Err(RuntimeStoreError::Fenced);
        }
        if expected_generation == 0 || expected_generation > i64::MAX as u64 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        context.validate(&mut tx).await?;
        let row =
            sqlx::query("SELECT * FROM production_runs WHERE id=? AND owner_id=? AND context_id=?")
                .bind(admission.run_id.to_string())
                .bind(context.owner.to_string())
                .bind(&context.id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::NotFound)?;
        let mut provider = envelope(&row)?;
        if provider.run.lease_generation != expected_generation
            || admission.lease_generation != expected_generation
        {
            return Err(RuntimeStoreError::StaleLease);
        }
        if provider.run.dispatch_fence != admission.dispatch_fence {
            return Err(RuntimeStoreError::Fenced);
        }
        if provider.run != *admission {
            return Err(RuntimeStoreError::Conflict);
        }
        self.production_authorized_run(&mut tx, &provider).await?;
        let supervisor_deadline: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms FROM production_supervisors WHERE context_id=?",
        )
        .bind(&context.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let extended = now(&mut tx)
            .await?
            .checked_add(60_000)
            .ok_or(RuntimeStoreError::Unavailable)?
            .min(supervisor_deadline);
        if extended <= admission.lease_deadline_ms {
            return Err(RuntimeStoreError::Busy);
        }
        let next = expected_generation
            .checked_add(1)
            .filter(|g| *g <= i64::MAX as u64)
            .ok_or(RuntimeStoreError::Unavailable)?;
        sqlx::query("INSERT INTO production_run_leases(run_id,generation,lease_deadline_ms,dispatch_fence) VALUES(?,?,?,?)")
            .bind(admission.run_id.to_string()).bind(next as i64).bind(extended)
            .bind(i64::try_from(admission.dispatch_fence).map_err(db)?).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("UPDATE production_runs SET lease_generation=?,lease_deadline_ms=? WHERE id=? AND lease_generation=?")
            .bind(next as i64).bind(extended).bind(admission.run_id.to_string()).bind(expected_generation as i64)
            .execute(&mut *tx).await.map_err(db)?;
        provider.run.lease_generation = next;
        provider.run.lease_deadline_ms = extended;
        tx.commit().await.map_err(db)?;
        Ok(provider.run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production_runtime::tests::{claim, ready, setup, snapshot};
    use std::time::Duration;
    #[tokio::test]
    async fn renewal_has_one_winner_and_stale_dispatch_cannot_spend_authority() {
        let f = setup().await;
        let b = ready(&f).await;
        let input = claim(&f, &b).await;
        let admission = f
            .handle
            .admit_run(&input, &b.session_id, b.generation, "lease-run")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(15)).await;
        let context_deadline = f.handle.heartbeat_supervisor().await.unwrap();
        let second = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
        let attached = f.handle.reattach_supervisor(&second).await.unwrap();
        let (a, z) = tokio::join!(
            f.handle.renew_lease(&admission.provider.run, 1),
            attached.renew_lease(&admission.provider.run, 1)
        );
        let renewed = match (a, z) {
            (Ok(a), Err(RuntimeStoreError::StaleLease))
            | (Err(RuntimeStoreError::StaleLease), Ok(a)) => a,
            results => panic!("unexpected renew race: {results:?}"),
        };
        assert_eq!(renewed.lease_generation, 2);
        assert!(renewed.lease_deadline_ms > admission.provider.run.lease_deadline_ms);
        assert!(renewed.lease_deadline_ms <= context_deadline);
        let before = snapshot(&f.store).await;
        assert!(matches!(
            f.handle
                .claim_provider_dispatch(&admission, "reserve-old")
                .await,
            Err(RuntimeStoreError::StaleLease)
        ));
        assert_eq!(snapshot(&f.store).await, before);
        let mut current = admission;
        current.provider.run = renewed;
        assert!(matches!(
            attached
                .claim_provider_dispatch(&current, "reserve-new")
                .await
                .unwrap(),
            DispatchClaimResult::Reserved(_)
        ));
        let history: i64 = sqlx::query_scalar("SELECT count(*) FROM production_run_leases")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
        assert_eq!(history, 2);
    }
    #[tokio::test]
    async fn forged_or_cancel_purpose_renewal_never_changes_rows() {
        let f = setup().await;
        let b = ready(&f).await;
        let input = claim(&f, &b).await;
        let admission = f
            .handle
            .admit_run(&input, &b.session_id, b.generation, "lease-forgery")
            .await
            .unwrap();
        let before = snapshot(&f.store).await;
        let mut forged = admission.provider.run.clone();
        forged.lease_deadline_ms += 1;
        assert!(matches!(
            f.handle.renew_lease(&forged, 1).await,
            Err(RuntimeStoreError::Conflict)
        ));
        forged = admission.provider.run.clone();
        forged.purpose = AdmissionPurpose::CancellationAcknowledgement;
        assert!(matches!(
            f.handle.renew_lease(&forged, 1).await,
            Err(RuntimeStoreError::Fenced)
        ));
        assert_eq!(snapshot(&f.store).await, before);
        sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0")
            .execute(&f.store.pool)
            .await
            .unwrap();
        let expired = snapshot(&f.store).await;
        assert!(matches!(
            f.handle.heartbeat_supervisor().await,
            Err(RuntimeStoreError::Expired)
        ));
        assert!(matches!(
            f.handle.renew_lease(&admission.provider.run, 1).await,
            Err(RuntimeStoreError::Expired)
        ));
        assert_eq!(snapshot(&f.store).await, expired);
    }
}
