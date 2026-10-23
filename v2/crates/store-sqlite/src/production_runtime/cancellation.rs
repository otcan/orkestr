//! Ordinary durable fencing precedes any interrupt-control receipt.
use super::admission::envelope;
use super::*;
use orkestr_v2_contracts::RunId;
use sqlx::sqlite::SqliteRow;

pub(super) fn receipt(run: &SqliteRow, cancel: &SqliteRow) -> Result<CancelReceipt> {
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

impl Store {
    pub(crate) async fn production_cancel(
        &self,
        owner: &OwnerId,
        run: &RunId,
        key: &str,
    ) -> Result<CancelReceipt> {
        Ok(self
            .production_cancel_guarded(owner, run, key, None, None)
            .await?
            .0)
    }
    pub(super) async fn production_cancel_guarded(
        &self,
        owner: &OwnerId,
        run: &RunId,
        key: &str,
        guard: Option<(&orkestr_v2_contracts::ConversationId, i64, Option<i64>)>,
        credential: Option<&str>,
    ) -> Result<(CancelReceipt, i64)> {
        let context = self.context()?;
        if owner != &context.owner {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if !valid(key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        if let Some(credential) = credential {
            let authorized: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
                .bind(crate::digest(credential)).bind(owner.to_string())
                .fetch_one(&mut *tx).await.map_err(db)?;
            if authorized != 1 {
                return Err(RuntimeStoreError::Unauthorized);
            }
        }
        // Replay authenticates immutable scope, not present-day dispatch authority.
        context.authenticate(&mut tx).await?;
        let row =
            sqlx::query("SELECT * FROM production_runs WHERE id=? AND owner_id=? AND context_id=?")
                .bind(run.to_string())
                .bind(owner.to_string())
                .bind(context.id.clone())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::NotFound)?;
        if let Some((conversation, _, _)) = guard {
            if row.get::<String, _>("conversation_id") != conversation.to_string() {
                return Err(RuntimeStoreError::NotFound);
            }
        }
        if let Some(cancel) = sqlx::query("SELECT * FROM production_cancellations WHERE run_id=?")
            .bind(run.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
        {
            if cancel.get::<&str, _>("request_key") != key {
                return Err(RuntimeStoreError::Fenced);
            }
            if let Some((_, expected, control)) = guard {
                if cancel.get::<Option<i64>, _>("request_revision") != Some(expected)
                    || cancel.get::<Option<i64>, _>("request_control_revision") != control
                {
                    return Err(RuntimeStoreError::Conflict);
                }
            }
            return Ok((
                receipt(&row, &cancel)?,
                cancel
                    .get::<Option<i64>, _>("receipt_revision")
                    .unwrap_or(0),
            ));
        }
        if let Some((conversation, expected, control)) = guard {
            let projection: i64 = sqlx::query_scalar(
                "SELECT revision FROM execution_revisions WHERE conversation_id=?",
            )
            .bind(conversation.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            // A sampled projection may lag streaming progress, but cannot claim
            // a future cut. Otherwise the resulting receipt would precede its
            // own requested revision even with a valid exact-run control CAS.
            if expected < 0 || expected > projection {
                return Err(RuntimeStoreError::Conflict);
            }
            if let Some(control) = control {
                let current: i64 = sqlx::query_scalar(
                    "SELECT revision FROM production_control_revisions WHERE run_id=?",
                )
                .bind(run.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
                if control <= 0 || current != control {
                    return Err(RuntimeStoreError::Conflict);
                }
            } else if projection != expected {
                return Err(RuntimeStoreError::Conflict);
            }
        }

        context.validate(&mut tx).await?;
        if row.get::<String, _>("incarnation_id") != context.incarnation.clone()
            || !matches!(row.get::<&str, _>("state"), "starting" | "running")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let dispatch: &str = row.get("dispatch_state");
        if !matches!(dispatch, "candidate" | "reserved" | "delivery_unknown") {
            return Err(RuntimeStoreError::Fenced);
        }
        let provider = envelope(&row)?;
        self.production_authorized_run_for_cancel(&mut tx, &provider)
            .await?;
        let generation = provider.run.lease_generation;
        let deadline = provider.run.lease_deadline_ms;
        let clock = now(&mut tx).await?;
        if deadline <= clock {
            return Err(RuntimeStoreError::Expired);
        }
        let fence: i64 = sqlx::query_scalar(
            "SELECT dispatch_fence FROM production_run_leases WHERE run_id=? AND generation=?",
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
            "SELECT lease_deadline_ms FROM production_supervisors WHERE context_id=?",
        )
        .bind(context.id.clone())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let mut deadline = clock
            .checked_add(60_000)
            .ok_or(RuntimeStoreError::Unavailable)?
            .min(supervisor_deadline);
        if provider.run.role == Role::Worker {
            deadline = deadline.min(provider.run.lease_deadline_ms);
        }
        let (state, inflight, control) = if dispatch == "delivery_unknown" {
            ("cancel_requested", "unknown", "pending")
        } else {
            ("cancelled", "not_dispatched", "not_dispatched")
        };
        sqlx::query("INSERT INTO production_run_leases(run_id,generation,lease_deadline_ms,purpose,dispatch_fence) VALUES(?,?,?,'cancellation_acknowledgement',?)")
            .bind(run.to_string()).bind(next).bind(deadline).bind(fence).execute(&mut *tx).await.map_err(db)?;
        let sequence: i64 = sqlx::query_scalar("UPDATE conversations SET sequence=sequence+1 WHERE id=? AND owner_id=? RETURNING sequence")
            .bind(provider.run.conversation_id.to_string()).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let event = Uuid::new_v4();
        sqlx::query("INSERT INTO events(id,owner_id,conversation_id,message_id,sequence,kind,schema_version) VALUES(?,?,?,NULL,?,'cancellation_requested',6)")
            .bind(event.to_string()).bind(owner.to_string()).bind(provider.run.conversation_id.to_string()).bind(sequence).execute(&mut *tx).await.map_err(db)?;
        let cancel = sqlx::query("INSERT INTO production_cancellations(run_id,event_id,request_key,lease_generation,dispatch_fence,lease_deadline_ms,receipt_state,inflight_status) VALUES(?,?,?,?,?,?,?,?) RETURNING *")
            .bind(run.to_string()).bind(event.to_string()).bind(key).bind(next).bind(fence).bind(deadline).bind(state).bind(inflight)
            .fetch_one(&mut *tx).await.map_err(db)?;
        // Only Deep consumes this inbox. A Worker/Fast Stop must not hold its
        // parent's independent owner input. The cancellation event is the cut.
        if provider.run.role == Role::Deep {
            sqlx::query("INSERT INTO production_stop_boundaries(event_id,owner_id,conversation_id,run_id,through_scope_sequence) VALUES(?,?,?,?,?)")
                .bind(event.to_string()).bind(owner.to_string()).bind(provider.run.conversation_id.to_string())
                .bind(run.to_string()).bind(sequence-1).execute(&mut *tx).await.map_err(db)?;
            sqlx::query("INSERT INTO production_held_inputs(event_id,conversation_id,scope_sequence,message_id,boundary_event_id,reason) SELECT i.event_id,i.conversation_id,i.sequence,i.message_id,?,'stop_boundary' FROM reasoning_inbox i WHERE i.conversation_id=? AND i.sequence<=? AND i.state IN ('queued','claimed') AND NOT EXISTS(SELECT 1 FROM production_held_inputs h WHERE h.event_id=i.event_id)")
                .bind(event.to_string()).bind(provider.run.conversation_id.to_string()).bind(sequence-1)
                .execute(&mut *tx).await.map_err(db)?;
        }
        sqlx::query("INSERT INTO outbox(event_id) VALUES(?)")
            .bind(event.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO production_control_outbox(event_id,run_id,state) VALUES(?,?,?)")
            .bind(event.to_string())
            .bind(run.to_string())
            .bind(control)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        // Locators are erased in the same commit as fencing and control intent.
        sqlx::query("UPDATE production_runs SET state=?,dispatch_state=CASE WHEN dispatch_state='delivery_unknown' THEN 'delivery_unknown' ELSE 'quarantined' END,candidate_hash=NULL,reservation_hash=NULL,reserve_key=NULL,lease_generation=?,dispatch_fence=?,lease_deadline_ms=? WHERE id=?")
            .bind(state).bind(next).bind(fence).bind(deadline).bind(run.to_string()).execute(&mut *tx).await.map_err(db)?;
        if state == "cancelled" {
            sqlx::query("UPDATE session_bindings SET state='ready',generation=generation+1 WHERE id=? AND generation=? AND state='busy'")
                .bind(provider.run.session_id.to_string()).bind(provider.binding.generation as i64)
                .execute(&mut *tx).await.map_err(db)?;
        }
        let revision: i64 =
            sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
                .bind(provider.run.conversation_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        sqlx::query("UPDATE production_cancellations SET request_revision=?,receipt_revision=?,request_control_revision=? WHERE run_id=?")
            .bind(guard.map(|(_, revision, _)| revision)).bind(revision).bind(guard.and_then(|(_, _, control)| control)).bind(run.to_string()).execute(&mut *tx).await.map_err(db)?;
        let result = receipt(&row, &cancel)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("cancel-before-commit").await?;
        tx.commit().await.map_err(db)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("cancel-after-commit").await?;
        Ok((result, revision))
    }
}
