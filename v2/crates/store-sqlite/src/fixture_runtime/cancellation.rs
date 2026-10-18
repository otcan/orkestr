//! Fixture-only durable fencing precedes any interrupt-control receipt.
use super::admission::envelope;
use super::*;
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::RunId;
use sqlx::sqlite::SqliteRow;

fn receipt(run: &SqliteRow, cancel: &SqliteRow) -> Result<CancelReceipt> {
    let mut admission = envelope(run)?.run;
    admission.lease_generation =
        u64::try_from(cancel.get::<i64, _>("lease_generation")).map_err(db)?;
    admission.dispatch_fence = u64::try_from(cancel.get::<i64, _>("dispatch_fence")).map_err(db)?;
    admission.lease_deadline_ms = cancel.get("lease_deadline_ms");
    admission.purpose = AdmissionPurpose::CancellationAcknowledgement;
    let (state, inflight_status) = match cancel.get::<&str, _>("receipt_state") {
        "cancel_requested" => (RunState::CancelRequested, InflightStatus::Unknown),
        "cancelled" => (RunState::Cancelled, InflightStatus::NotDispatched),
        _ => return Err(RuntimeStoreError::Unavailable),
    };
    Ok(CancelReceipt {
        new_fenced_admission: admission,
        state,
        inflight_status,
    })
}

impl FixtureSupervisorStore {
    pub(super) async fn cancel(
        &self,
        owner: &OwnerId,
        run: &RunId,
        key: &str,
    ) -> Result<CancelReceipt> {
        if owner != &self.owner {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if !valid(key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self
            .store
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        // Replay authenticates immutable scope, not present-day dispatch authority.
        let context: i64 = sqlx::query_scalar("SELECT count(*) FROM fixture_supervisors WHERE context_id=? AND owner_id=? AND namespace=? AND supervisor_key=?")
            .bind(self.context_id.to_string()).bind(owner.to_string()).bind(&self.namespace).bind(&self.supervisor_key)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if context != 1 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let row =
            sqlx::query("SELECT * FROM fixture_runs WHERE id=? AND owner_id=? AND context_id=?")
                .bind(run.to_string())
                .bind(owner.to_string())
                .bind(self.context_id.to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::NotFound)?;
        if let Some(cancel) = sqlx::query("SELECT * FROM fixture_cancellations WHERE run_id=?")
            .bind(run.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
        {
            if cancel.get::<&str, _>("request_key") != key {
                return Err(RuntimeStoreError::Fenced);
            }
            return receipt(&row, &cancel);
        }
        self.validate_in(&mut tx).await?;
        if row.get::<String, _>("incarnation_id") != self.incarnation_id.to_string()
            || !matches!(row.get::<&str, _>("state"), "starting" | "running")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let dispatch: &str = row.get("dispatch_state");
        if !matches!(dispatch, "candidate" | "reserved" | "delivery_unknown") {
            return Err(RuntimeStoreError::Fenced);
        }
        let provider = envelope(&row)?;
        self.ready_in(&mut tx, &provider).await?;
        let (generation, deadline) = super::leases::current(&mut tx, run).await?;
        let clock = now(&mut tx).await?;
        if deadline <= clock {
            return Err(RuntimeStoreError::Expired);
        }
        let fence: i64 = sqlx::query_scalar(
            "SELECT dispatch_fence FROM fixture_run_leases WHERE run_id=? AND generation=?",
        )
        .bind(run.to_string())
        .bind(generation as i64)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let next = i64::try_from(generation)
            .map_err(db)?
            .checked_add(1)
            .ok_or(RuntimeStoreError::Unavailable)?;
        let fence = fence.checked_add(1).ok_or(RuntimeStoreError::Unavailable)?;
        let supervisor_deadline: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms FROM fixture_supervisors WHERE context_id=?",
        )
        .bind(self.context_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let deadline = clock
            .checked_add(LEASE_MS)
            .ok_or(RuntimeStoreError::Unavailable)?
            .min(supervisor_deadline);
        let (state, inflight, control) = if dispatch == "delivery_unknown" {
            ("cancel_requested", "unknown", "pending")
        } else {
            ("cancelled", "not_dispatched", "not_dispatched")
        };
        sqlx::query("INSERT INTO fixture_run_leases(run_id,generation,lease_deadline_ms,purpose,dispatch_fence) VALUES(?,?,?,'cancellation_acknowledgement',?)")
            .bind(run.to_string()).bind(next).bind(deadline).bind(fence).execute(&mut *tx).await.map_err(db)?;
        let sequence: i64 = sqlx::query_scalar("UPDATE conversations SET sequence=sequence+1 WHERE id=? AND owner_id=? RETURNING sequence")
            .bind(provider.run.conversation_id.to_string()).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let event = Uuid::new_v4();
        sqlx::query("INSERT INTO events(id,owner_id,conversation_id,message_id,sequence,kind,schema_version) VALUES(?,?,?,NULL,?,'fixture_cancellation_requested',3)")
            .bind(event.to_string()).bind(owner.to_string()).bind(provider.run.conversation_id.to_string()).bind(sequence).execute(&mut *tx).await.map_err(db)?;
        let cancel = sqlx::query("INSERT INTO fixture_cancellations(run_id,event_id,request_key,lease_generation,dispatch_fence,lease_deadline_ms,receipt_state,inflight_status) VALUES(?,?,?,?,?,?,?,?) RETURNING *")
            .bind(run.to_string()).bind(event.to_string()).bind(key).bind(next).bind(fence).bind(deadline).bind(state).bind(inflight)
            .fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO outbox(event_id) VALUES(?)")
            .bind(event.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO fixture_control_outbox(event_id,run_id,state) VALUES(?,?,?)")
            .bind(event.to_string())
            .bind(run.to_string())
            .bind(control)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        // Locators are erased in the same commit as fencing and control intent.
        sqlx::query("UPDATE fixture_runs SET state=?,dispatch_state=CASE WHEN dispatch_state='delivery_unknown' THEN 'delivery_unknown' ELSE 'quarantined' END,candidate_hash=NULL,reservation_hash=NULL,reserve_key=NULL WHERE id=?")
            .bind(state).bind(run.to_string()).execute(&mut *tx).await.map_err(db)?;
        let result = receipt(&row, &cancel)?;
        #[cfg(feature = "fixture-test-controls")]
        self.fixture_checkpoint("cancel-before-commit").await?;
        tx.commit().await.map_err(db)?;
        #[cfg(feature = "fixture-test-controls")]
        self.fixture_checkpoint("cancel-after-commit").await?;
        Ok(result)
    }
}
