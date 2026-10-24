//! Production evidence is metadata, never an acceptance or effect grant.
use super::*;
use crate::runtime::ledger::hash;
use orkestr_v2_contracts::EventId;

impl Store {
    pub(crate) async fn production_observe(
        &self,
        owner: &OwnerId,
        provider: &ProviderAdmission,
        input: &ProviderEventInput,
    ) -> Result<ProviderEventReceipt> {
        if !input.is_bounded() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let context = self.context()?;
        if owner != &context.owner || owner != &provider.run.owner_id {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        // Authenticate principal and exact issued historical envelope BEFORE
        // receipt lookup, but defer current expiry/incarnation checks for replay.
        context.authenticate(&mut tx).await?;
        let row =
            sqlx::query("SELECT * FROM production_runs WHERE id=? AND owner_id=? AND context_id=?")
                .bind(input.run_id.to_string())
                .bind(owner.to_string())
                .bind(&context.id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::NotFound)?;
        super::leases::authenticate(&mut tx, &row, provider).await?;
        if input.run_id != provider.run.run_id
            || input.session_id != provider.run.session_id
            || input.lease_generation != provider.run.lease_generation
            || input.dispatch_fence != provider.run.dispatch_fence
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let (kind, value) = match &input.event {
            ProviderEvent::Started => ("started", ""),
            ProviderEvent::ApprovalRequested => ("approval_requested", ""),
            ProviderEvent::CompletedProposal { synthetic: false } => {
                ("completed_proposal", "false")
            }
            ProviderEvent::CompletedProposal { synthetic: true } => ("completed_proposal", "true"),
            ProviderEvent::Failed => ("failed", ""),
            // The closed class joins the digest so a replay cannot change it.
            ProviderEvent::FailedWith(class) => ("failed", failure_class_name(*class)),
            ProviderEvent::Lost => ("lost", ""),
            ProviderEvent::Progress(text) => ("progress", text.as_str()),
            ProviderEvent::Stopped => ("stopped", ""),
        };
        let digest = hash(
            "production-observation-v1",
            &[
                &input.run_id.to_string(),
                &input.session_id.to_string(),
                &input.sequence.to_string(),
                &input.lease_generation.to_string(),
                &input.dispatch_fence.to_string(),
                kind,
                value,
            ],
        );
        if let Some(committed) = sqlx::query("SELECT o.*,e.sequence AS scope_sequence FROM production_observations o JOIN events e ON e.id=o.event_id WHERE o.run_id=? AND o.run_sequence=?")
            .bind(input.run_id.to_string()).bind(input.sequence as i64).fetch_optional(&mut *tx).await.map_err(db)? {
            if committed.get::<String,_>("semantic_digest") != digest { return Err(RuntimeStoreError::Conflict); }
            return Ok(ProviderEventReceipt {
                event_id: EventId(Uuid::parse_str(&committed.get::<String,_>("event_id")).map_err(db)?),
                scope_sequence: committed.get("scope_sequence"), sequence: input.sequence,
                state: state(committed.get("receipt_state"))?, duplicate: true,
            });
        }
        let row = self.production_authorized_run(&mut tx, provider).await?;
        let stopping = matches!(input.event, ProviderEvent::Stopped);
        let purpose = if stopping {
            AdmissionPurpose::CancellationAcknowledgement
        } else {
            AdmissionPurpose::Execution
        };
        if provider.run.purpose != purpose
            || row.get::<&str, _>("dispatch_state") != "delivery_unknown"
        {
            return Err(RuntimeStoreError::Fenced);
        }
        if matches!(
            input.event,
            ProviderEvent::CompletedProposal { synthetic: true }
        ) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        if !matches!(
            input.event,
            ProviderEvent::Failed
                | ProviderEvent::FailedWith(_)
                | ProviderEvent::Lost
                | ProviderEvent::Stopped
        ) {
            self.require_observed_native(&mut tx, provider).await?;
        }
        let next: i64 = sqlx::query_scalar(
            "SELECT coalesce(max(run_sequence),0)+1 FROM production_observations WHERE run_id=?",
        )
        .bind(input.run_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if next != input.sequence as i64 {
            return Err(RuntimeStoreError::Conflict);
        }
        let target = match (row.get::<&str, _>("state"), kind) {
            ("cancel_requested", "stopped") => "cancelled",
            ("starting", "started") | ("running", "approval_requested" | "progress") => "running",
            ("running", "completed_proposal") => "awaiting_acceptance",
            ("starting" | "running", "failed") => "failed",
            ("starting" | "running", "lost") => "blocked",
            _ => return Err(RuntimeStoreError::Conflict),
        };
        let sequence: i64 = sqlx::query_scalar("UPDATE conversations SET sequence=sequence+1 WHERE id=? AND owner_id=? RETURNING sequence")
            .bind(provider.run.conversation_id.to_string()).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let event_id = EventId(Uuid::new_v4());
        sqlx::query("INSERT INTO events(id,owner_id,conversation_id,message_id,sequence,kind,schema_version) VALUES(?,?,?,NULL,?,?,?)")
            .bind(event_id.to_string()).bind(owner.to_string()).bind(provider.run.conversation_id.to_string()).bind(sequence)
            .bind(if stopping { "provider_stopped" } else { "provider_observed" }).bind(if stopping { 7 } else if kind == "progress" { 8 } else { 5 })
            .execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO production_observations(event_id,run_id,run_sequence,semantic_digest,kind,lease_generation,dispatch_fence,receipt_state) VALUES(?,?,?,?,?,?,?,?)")
            .bind(event_id.to_string()).bind(input.run_id.to_string()).bind(input.sequence as i64).bind(digest).bind(kind)
            .bind(input.lease_generation as i64).bind(input.dispatch_fence as i64).bind(target).execute(&mut *tx).await.map_err(db)?;
        if let ProviderEvent::FailedWith(class) = &input.event {
            sqlx::query(
                "INSERT INTO production_failure_classes(event_id,run_id,class) VALUES(?,?,?)",
            )
            .bind(event_id.to_string())
            .bind(input.run_id.to_string())
            .bind(failure_class_name(*class))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        }
        if kind == "progress" {
            sqlx::query("INSERT INTO production_payloads(id,event_id,owner_id,conversation_id,run_id,text) VALUES(?,?,?,?,?,?)")
                .bind(Uuid::new_v4().to_string()).bind(event_id.to_string()).bind(owner.to_string())
                .bind(provider.run.conversation_id.to_string()).bind(input.run_id.to_string()).bind(value)
                .execute(&mut *tx).await.map_err(db)?;
        }
        sqlx::query("INSERT INTO outbox(event_id) VALUES(?)")
            .bind(event_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("UPDATE production_runs SET state=? WHERE id=?")
            .bind(target)
            .bind(input.run_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        if stopping {
            sqlx::query("UPDATE production_control_outbox SET state='acknowledged' WHERE run_id=? AND state='pending'")
                .bind(input.run_id.to_string()).execute(&mut *tx).await.map_err(db)?;
            sqlx::query("UPDATE session_bindings SET state='ready',generation=generation+1 WHERE id=? AND generation=? AND state='busy'")
                .bind(input.session_id.to_string()).bind(provider.binding.generation as i64).execute(&mut *tx).await.map_err(db)?;
        }
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint(if stopping {
            "stopped-before-commit"
        } else {
            "observation-before-commit"
        })
        .await?;
        tx.commit().await.map_err(db)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint(if stopping {
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
pub(super) fn failure_class_name(
    class: orkestr_v2_contracts::ExecutionFailureClass,
) -> &'static str {
    use orkestr_v2_contracts::ExecutionFailureClass as Class;
    match class {
        Class::Policy => "policy",
        Class::Authentication => "authentication",
        Class::Quota => "quota",
        Class::Billing => "billing",
        Class::Provider => "provider",
        Class::Unknown => "unknown",
    }
}

pub(super) fn failure_class(value: &str) -> Option<orkestr_v2_contracts::ExecutionFailureClass> {
    use orkestr_v2_contracts::ExecutionFailureClass as Class;
    Some(match value {
        "policy" => Class::Policy,
        "authentication" => Class::Authentication,
        "quota" => Class::Quota,
        "billing" => Class::Billing,
        "provider" => Class::Provider,
        "unknown" => Class::Unknown,
        _ => return None,
    })
}

fn state(value: &str) -> Result<RunState> {
    match value {
        "cancelled" => Ok(RunState::Cancelled),
        "running" => Ok(RunState::Running),
        "awaiting_acceptance" => Ok(RunState::AwaitingAcceptance),
        "failed" => Ok(RunState::Failed),
        "blocked" => Ok(RunState::Blocked),
        _ => Err(RuntimeStoreError::Unavailable),
    }
}
