//! Fixture-only canonical metadata evidence. Never grants effect or acceptance authority.
use super::admission::{envelope, hash};
use super::*;
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::EventId;

fn state(value: &str) -> Result<RunState> {
    match value {
        "running" => Ok(RunState::Running),
        "awaiting_acceptance" => Ok(RunState::AwaitingAcceptance),
        "failed" => Ok(RunState::Failed),
        "blocked" => Ok(RunState::Blocked),
        "cancelled" => Ok(RunState::Cancelled),
        _ => Err(RuntimeStoreError::Unavailable),
    }
}
impl FixtureSupervisorStore {
    pub(super) async fn append_observation(
        &self,
        owner: &OwnerId,
        provider: &ProviderAdmission,
        input: &ProviderEventInput,
    ) -> Result<ProviderEventReceipt> {
        if !input.is_bounded() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        if owner != &self.owner || owner != &provider.run.owner_id {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let mut tx = self
            .store
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        // Immutable principal/context authentication precedes any receipt lookup.
        // Expiry/incarnation checks are deliberately deferred until after committed replay.
        let context: i64 = sqlx::query_scalar("SELECT count(*) FROM fixture_supervisors WHERE context_id=? AND owner_id=? AND namespace=? AND supervisor_key=?")
            .bind(self.context_id.to_string()).bind(self.owner.to_string()).bind(&self.namespace).bind(&self.supervisor_key)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if context != 1 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let row =
            sqlx::query("SELECT * FROM fixture_runs WHERE id=? AND owner_id=? AND context_id=?")
                .bind(input.run_id.to_string())
                .bind(owner.to_string())
                .bind(self.context_id.to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::NotFound)?;
        let canonical = envelope(&row)?;
        super::leases::authenticate(&mut tx, &row, provider).await?;
        if input.run_id != canonical.run.run_id || input.session_id != canonical.run.session_id {
            return Err(RuntimeStoreError::Conflict);
        }
        let stopped = matches!(input.event, ProviderEvent::Stopped);
        let (kind, synthetic, progress) = match &input.event {
            ProviderEvent::Started => ("started", None, None),
            ProviderEvent::ApprovalRequested => ("approval_requested", None, None),
            ProviderEvent::CompletedProposal { synthetic } => {
                ("completed_proposal", Some(i64::from(*synthetic)), None)
            }
            ProviderEvent::Failed | ProviderEvent::FailedWith(_) => ("failed", None, None),
            ProviderEvent::Lost => ("lost", None, None),
            ProviderEvent::Progress(text) => ("progress", None, Some(text.as_str())),
            ProviderEvent::Stopped => ("stopped", None, None),
        };
        let digest = hash(
            "fixture-observation-v1",
            &[
                &input.run_id.to_string(),
                &input.session_id.to_string(),
                &input.sequence.to_string(),
                &input.lease_generation.to_string(),
                &input.dispatch_fence.to_string(),
                kind,
                &synthetic.map(|v| v.to_string()).unwrap_or_default(),
                progress.unwrap_or_default(),
            ],
        );
        if let Some(committed) = sqlx::query("SELECT o.*,e.sequence AS scope_sequence FROM fixture_observations o JOIN events e ON e.id=o.event_id WHERE o.run_id=? AND o.run_sequence=?")
            .bind(input.run_id.to_string()).bind(input.sequence as i64).fetch_optional(&mut *tx).await.map_err(db)? {
            if committed.get::<String,_>("semantic_digest") != digest || input.lease_generation != provider.run.lease_generation || input.dispatch_fence != provider.run.dispatch_fence { return Err(RuntimeStoreError::Conflict); }
            return Ok(ProviderEventReceipt { event_id: EventId(Uuid::parse_str(&committed.get::<String,_>("event_id")).map_err(db)?), scope_sequence: committed.get("scope_sequence"), sequence: input.sequence, state: state(committed.get("receipt_state"))?, duplicate: true });
        }
        if (stopped && provider.run.purpose != AdmissionPurpose::CancellationAcknowledgement)
            || (!stopped && provider.run.purpose != AdmissionPurpose::Execution)
        {
            return Err(RuntimeStoreError::Fenced);
        }
        self.validate_in(&mut tx).await?;
        if row.get::<String, _>("incarnation_id") != self.incarnation_id.to_string() {
            return Err(RuntimeStoreError::Fenced);
        }
        let (generation, deadline) = super::leases::current(&mut tx, &input.run_id).await?;
        let fence: i64 = sqlx::query_scalar(
            "SELECT dispatch_fence FROM fixture_run_leases WHERE run_id=? AND generation=?",
        )
        .bind(input.run_id.to_string())
        .bind(generation as i64)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if input.dispatch_fence != fence as u64 {
            return Err(RuntimeStoreError::Fenced);
        }
        if input.lease_generation != generation || provider.run.lease_generation != generation {
            return Err(RuntimeStoreError::StaleLease);
        }
        if deadline <= now(&mut tx).await? {
            return Err(RuntimeStoreError::Expired);
        }
        if row.get::<&str, _>("dispatch_state") != "delivery_unknown" {
            return Err(RuntimeStoreError::Fenced);
        }
        self.ready_in(&mut tx, provider).await?;
        // Unsupported new evidence cannot be persisted, but a changed replay
        // above must still conflict rather than masquerade as a retryable outage.
        if matches!(input.event, ProviderEvent::Progress(_)) {
            return Err(RuntimeStoreError::Unavailable);
        }
        let next: i64 = sqlx::query_scalar(
            "SELECT coalesce(max(run_sequence),0)+1 FROM fixture_observations WHERE run_id=?",
        )
        .bind(input.run_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if next != input.sequence as i64 {
            return Err(RuntimeStoreError::Conflict);
        }
        let target = match (row.get::<&str, _>("state"), kind) {
            ("starting", "started") | ("running", "approval_requested") => "running",
            ("running", "completed_proposal") => "awaiting_acceptance",
            ("starting" | "running", "failed") => "failed",
            ("starting" | "running", "lost") => "blocked",
            ("cancel_requested", "stopped") => "cancelled",
            _ => return Err(RuntimeStoreError::Conflict),
        };
        let sequence: i64 = sqlx::query_scalar("UPDATE conversations SET sequence=sequence+1 WHERE id=? AND owner_id=? RETURNING sequence")
            .bind(canonical.run.conversation_id.to_string()).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let event_id = EventId(Uuid::new_v4());
        sqlx::query("INSERT INTO events(id,owner_id,conversation_id,message_id,sequence,kind,schema_version) VALUES(?,?,?,NULL,?,?,?)")
            .bind(event_id.to_string()).bind(owner.to_string()).bind(canonical.run.conversation_id.to_string()).bind(sequence)
            .bind(if stopped { "fixture_provider_stopped" } else { "fixture_provider_observed" })
            .bind(if stopped { 4_i64 } else { 2_i64 }).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO fixture_observations(event_id,run_id,run_sequence,semantic_digest,kind,synthetic,lease_generation,dispatch_fence,receipt_state) VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(event_id.to_string()).bind(input.run_id.to_string()).bind(input.sequence as i64).bind(digest).bind(kind).bind(synthetic).bind(input.lease_generation as i64).bind(input.dispatch_fence as i64).bind(target).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO outbox(event_id) VALUES(?)")
            .bind(event_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("UPDATE fixture_runs SET state=? WHERE id=?")
            .bind(target)
            .bind(input.run_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        if stopped {
            sqlx::query("UPDATE fixture_control_outbox SET state='acknowledged' WHERE run_id=? AND state='pending'")
                .bind(input.run_id.to_string()).execute(&mut *tx).await.map_err(db)?;
        }
        #[cfg(feature = "fixture-test-controls")]
        self.fixture_checkpoint(if stopped {
            "stopped-before-commit"
        } else {
            "observation-before-commit"
        })
        .await?;
        tx.commit().await.map_err(db)?;
        #[cfg(feature = "fixture-test-controls")]
        self.fixture_checkpoint(if stopped {
            "stopped-after-commit"
        } else {
            "observation-after-commit"
        })
        .await?;
        Ok(ProviderEventReceipt {
            event_id,
            scope_sequence: sequence,
            sequence: input.sequence,
            state: state(target)?,
            duplicate: false,
        })
    }
}
