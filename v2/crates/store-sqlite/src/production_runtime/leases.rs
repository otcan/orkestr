//! Store-clock bounds; renewal never changes provider identity or dispatch purpose.
use super::admission::envelope;
use super::*;
use sqlx::sqlite::SqliteRow;
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
    let issued: i64 = sqlx::query_scalar("SELECT count(*) FROM production_run_leases WHERE run_id=? AND generation=? AND lease_deadline_ms=? AND dispatch_fence=? AND purpose=?")
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

    /// Read-only: how long Core's lease for this bound supervisor context has
    /// left, in ms of Core's own clock.
    ///
    /// `heartbeat_supervisor` is a `BEGIN IMMEDIATE` write, so it reports
    /// Busy/Unavailable while another writer holds SQLite past busy_timeout.
    /// This read runs the heartbeat's own `validate` (machine session, window
    /// scope, incarnation, generation, expiry) in a plain read transaction,
    /// which needs no write lock and still answers then, and takes the
    /// remaining time from the same snapshot. So it refuses exactly as the
    /// heartbeat would (Unauthorized, Fenced, Expired), and it never renews or
    /// revives the lease.
    pub async fn supervisor_lease_remaining_ms(&self) -> Result<i64> {
        let context = self.context()?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        context.validate(&mut tx).await?;
        let remaining: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms-CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) FROM production_supervisors WHERE context_id=? AND incarnation_id=? AND generation=?",
        )
        .bind(&context.id)
        .bind(&context.incarnation)
        .bind(context.generation)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Fenced)?;
        tx.commit().await.map_err(db)?;
        Ok(remaining)
    }

    pub(crate) async fn production_renew(
        &self,
        admission: &RunAdmission,
        expected_generation: u64,
    ) -> Result<RunAdmission> {
        self.renew_exact(admission, expected_generation, false)
            .await
    }

    pub(super) async fn renew_exact(
        &self,
        admission: &RunAdmission,
        expected_generation: u64,
        running_only: bool,
    ) -> Result<RunAdmission> {
        self.renew_exact_budget(admission, expected_generation, running_only, None)
            .await
    }

    pub(super) async fn renew_exact_budget(
        &self,
        admission: &RunAdmission,
        expected_generation: u64,
        running_only: bool,
        worker_budget: Option<i64>,
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
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let workspace = self
            .check_run_workspace_before_writer(&admission.run_id)
            .await?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let store = &*workspace;
        #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
        let store = self;
        let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
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
        store.production_authorized_run(&mut tx, &provider).await?;
        if running_only
            && (row.get::<&str, _>("state") != "running"
                || row.get::<&str, _>("dispatch_state") != "delivery_unknown")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let supervisor_deadline: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms FROM production_supervisors WHERE context_id=?",
        )
        .bind(&context.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let mut extended = now(&mut tx)
            .await?
            .checked_add(60_000)
            .ok_or(RuntimeStoreError::Unavailable)?
            .min(supervisor_deadline);
        let mut retained = None;
        if provider.run.role == Role::Worker {
            let limit:i64=sqlx::query_scalar("SELECT expires_at_ms FROM worker_provider_delegations WHERE admitted_run_id=? AND state='admitted'")
                .bind(admission.run_id.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
            extended = if let Some(budget) = worker_budget {
                let (deadline, parent) = store
                    .worker_budget_deadline_in(&mut tx, &row, budget, supervisor_deadline)
                    .await?;
                retained = parent;
                deadline
            } else {
                extended.min(limit)
            };
        }
        if extended <= admission.lease_deadline_ms {
            return Err(RuntimeStoreError::Busy);
        }
        if let Some(parent) = &retained {
            store
                .extend_retained_parent_in(&mut tx, parent, extended)
                .await?;
        }
        if worker_budget.is_some() {
            if provider.run.role != Role::Worker {
                return Err(RuntimeStoreError::Fenced);
            }
            sqlx::query("UPDATE worker_provider_delegations SET expires_at_ms=? WHERE admitted_run_id=? AND state='admitted'")
                .bind(extended).bind(admission.run_id.to_string()).execute(&mut *tx).await.map_err(db)?;
        }
        let next = expected_generation
            .checked_add(1)
            .filter(|g| *g <= i64::MAX as u64)
            .ok_or(RuntimeStoreError::Unavailable)?;
        sqlx::query("INSERT INTO production_run_leases(run_id,generation,lease_deadline_ms,dispatch_fence) VALUES(?,?,?,?)")
            .bind(admission.run_id.to_string()).bind(next as i64).bind(extended)
            .bind(i64::try_from(admission.dispatch_fence).map_err(db)?).execute(&mut *tx).await.map_err(db)?;
        // Preserve exact descendant lineage through this same-parent renewal.
        // Child expiry, binding, dispatch fence and one-use grants never change.
        sqlx::query("UPDATE worker_provider_delegations SET parent_lease_generation=?,parent_deadline_ms=? WHERE parent_run_id=? AND context_id=? AND incarnation_id=? AND parent_lease_generation=? AND parent_deadline_ms=? AND parent_dispatch_fence=? AND state IN ('delegated','admitted')")
            .bind(next as i64).bind(extended).bind(admission.run_id.to_string())
            .bind(&context.id).bind(&context.incarnation).bind(expected_generation as i64)
            .bind(admission.lease_deadline_ms).bind(admission.dispatch_fence as i64)
            .execute(&mut *tx).await.map_err(db)?;
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

    /// A writer that holds SQLite past busy_timeout makes the supervisor
    /// heartbeat (BEGIN IMMEDIATE) fail as Unavailable. The read-only lease
    /// check still answers with Core's real remaining lease, and the lease is
    /// renewable again once the writer is gone.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lease_read_answers_while_a_writer_blocks_the_heartbeat() {
        let f = setup().await;
        let fresh = f.handle.supervisor_lease_remaining_ms().await.unwrap();
        assert!((50_000..=60_000).contains(&fresh), "fresh lease {fresh}");
        let mut writer = f.store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=lease_deadline_ms")
            .execute(&mut *writer)
            .await
            .unwrap();
        let started = std::time::Instant::now();
        assert!(matches!(
            f.handle.heartbeat_supervisor().await,
            Err(RuntimeStoreError::Unavailable)
        ));
        assert!(
            started.elapsed() >= Duration::from_secs(4),
            "the heartbeat must have waited on the held write lock"
        );
        let during = f.handle.supervisor_lease_remaining_ms().await.unwrap();
        assert!(
            during > 0 && during <= fresh,
            "lease read while locked: {during}"
        );
        writer.rollback().await.unwrap();
        f.handle.heartbeat_supervisor().await.unwrap();
        assert!(f.handle.supervisor_lease_remaining_ms().await.unwrap() > during);
    }

    /// The read refuses exactly as the heartbeat would: a lapsed lease is
    /// Expired (never revived), a takeover is Fenced, a revoked machine
    /// session is Unauthorized.
    #[tokio::test]
    async fn lease_read_refuses_as_the_heartbeat_would() {
        let f = setup().await;
        sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0")
            .execute(&f.store.pool)
            .await
            .unwrap();
        assert!(matches!(
            f.handle.supervisor_lease_remaining_ms().await,
            Err(RuntimeStoreError::Expired)
        ));
        assert!(matches!(
            f.handle.heartbeat_supervisor().await,
            Err(RuntimeStoreError::Expired)
        ));
        let incarnation = f.handle.supervisor_incarnation().unwrap().to_owned();
        let successor = f
            .store
            .authorize_supervisor(
                &f.token,
                crate::production_runtime::tests::config(ProductionTakeover::ExpiredPredecessor {
                    incarnation_id: incarnation,
                }),
            )
            .await
            .unwrap();
        assert!(matches!(
            f.handle.supervisor_lease_remaining_ms().await,
            Err(RuntimeStoreError::Fenced)
        ));
        let fresh = successor.supervisor_lease_remaining_ms().await.unwrap();
        assert!((50_000..=60_000).contains(&fresh), "fresh lease {fresh}");
        f.store.revoke_session(&f.token).await.unwrap();
        assert!(matches!(
            successor.supervisor_lease_remaining_ms().await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert!(matches!(
            successor.heartbeat_supervisor().await,
            Err(RuntimeStoreError::Unauthorized)
        ));
    }
}
