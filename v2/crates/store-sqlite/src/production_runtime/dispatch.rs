use super::admission::envelope;
use super::*;
use crate::runtime::ledger::{self, hash, secret, Ledger};
use sqlx::sqlite::SqliteRow;
impl Store {
    /// Handoff context and the Fast history digest, both prefixed to `text`.
    async fn attach_turn_context(
        &self,
        tx: &mut SqliteConnection,
        provider: &ProviderAdmission,
        row: &sqlx::sqlite::SqliteRow,
        text: String,
    ) -> Result<String> {
        let text = super::execution_window::handoff_context::attach(tx, provider, text).await?;
        super::fast_digest::attach(
            tx,
            provider,
            row.get("event_id"),
            row.get("scope_sequence"),
            text,
        )
        .await
    }

    pub(crate) async fn check_context_in(
        &self,
        conn: &mut SqliteConnection,
        owner: &OwnerId,
    ) -> Result<()> {
        if let Some(c) = &self.authority {
            if c.owner != *owner {
                return Err(RuntimeStoreError::Unauthorized);
            }
            c.validate(conn).await?;
        }
        Ok(())
    }
    pub(super) async fn production_authorized_run(
        &self,
        conn: &mut SqliteConnection,
        p: &ProviderAdmission,
    ) -> Result<SqliteRow> {
        self.production_authorized_run_checked(conn, p, true).await
    }
    // Negative authority only: used solely by the existing cancellation writer.
    // Workspace revocation must not prevent issuing owned cleanup control.
    pub(super) async fn production_authorized_run_for_cancel(
        &self,
        conn: &mut SqliteConnection,
        p: &ProviderAdmission,
    ) -> Result<SqliteRow> {
        self.production_authorized_run_checked(conn, p, false).await
    }
    async fn production_authorized_run_checked(
        &self,
        conn: &mut SqliteConnection,
        p: &ProviderAdmission,
        workspace_effect: bool,
    ) -> Result<SqliteRow> {
        let c = self.context()?;
        c.validate(conn).await?;
        if p.run.owner_id != c.owner {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let row =
            sqlx::query("SELECT * FROM production_runs WHERE id=? AND owner_id=? AND context_id=?")
                .bind(p.run.run_id.to_string())
                .bind(c.owner.to_string())
                .bind(&c.id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::NotFound)?;
        self.window_effect_in(
            conn,
            p,
            row.get("event_id"),
            !workspace_effect || p.run.purpose != AdmissionPurpose::Execution,
        )
        .await?;
        if row.get::<String, _>("incarnation_id") != c.incarnation {
            return Err(RuntimeStoreError::Fenced);
        }
        if !matches!(
            row.get::<&str, _>("state"),
            "starting" | "running" | "cancel_requested"
        ) {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut canonical = envelope(&row)?;
        if row.get::<&str, _>("state") == "cancel_requested" {
            canonical.run.purpose = AdmissionPurpose::CancellationAcknowledgement;
        }
        if canonical.run.dispatch_fence != p.run.dispatch_fence {
            return Err(RuntimeStoreError::Fenced);
        }
        if canonical.run.lease_generation != p.run.lease_generation {
            return Err(RuntimeStoreError::StaleLease);
        }
        if canonical != *p {
            return Err(RuntimeStoreError::Conflict);
        }
        if p.run.lease_deadline_ms <= now(conn).await? {
            return Err(RuntimeStoreError::Expired);
        }
        let ready:i64=sqlx::query_scalar("SELECT count(*) FROM session_bindings b JOIN production_readiness r ON r.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND b.role=? AND b.state='busy' AND b.generation=? AND b.provider_kind=? AND b.provider_namespace=? AND b.native_session_id=? AND r.context_id=? AND r.incarnation_id=?")
            .bind(p.run.session_id.to_string()).bind(c.owner.to_string()).bind(p.run.conversation_id.to_string()).bind(match p.run.role { Role::Deep => "deep", Role::Fast => "fast", Role::Worker => "worker" }).bind(i64::try_from(p.binding.generation).map_err(db)?)
            .bind(provider_name(c.provider)?).bind(&c.namespace).bind(&p.run.native_session_id).bind(&c.id).bind(&c.incarnation).fetch_one(&mut *conn).await.map_err(db)?;
        if ready != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        // Timer disable/rollback fences even an already-admitted input. Keep
        // cancellation authority usable so an owned process can still be stopped.
        if p.run.purpose == AdmissionPurpose::Execution {
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            if workspace_effect {
                self.validate_workspace_binding(conn, &p.binding).await?;
            }
            #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
            let _ = workspace_effect;
            let held: i64 =
                sqlx::query_scalar("SELECT count(*) FROM ordinary_input_holds WHERE event_id=?")
                    .bind(row.get::<String, _>("event_id"))
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(db)?;
            if held != 0 {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        if p.run.role == Role::Worker {
            self.worker_lineage_in(conn, &row).await?;
            let task_key: String = sqlx::query_scalar(
                "SELECT request_key FROM worker_provider_delegations WHERE id=?",
            )
            .bind(row.get::<&str, _>("worker_delegation_id"))
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
            if p.run.purpose == AdmissionPurpose::Execution && task_key.starts_with("task:") {
                // A budget is effective immediately, including before the first
                // renewal. Cancellation remains usable for owned cleanup.
                let deadline: Option<i64> = sqlx::query_scalar(
                    "SELECT min(t.created_at_ms+t.execution_budget_ms,coalesce(b.deadline_ms,t.created_at_ms+t.execution_budget_ms)) FROM worker_tasks t LEFT JOIN worker_running_budgets b ON b.task_id=t.id WHERE t.delegation_id=(SELECT worker_delegation_id FROM production_runs WHERE id=?) AND t.execution_budget_ms IS NOT NULL"
                ).bind(p.run.run_id.to_string()).fetch_optional(&mut *conn).await.map_err(db)?.flatten();
                if let Some(deadline) = deadline {
                    if deadline <= now(conn).await? {
                        return Err(RuntimeStoreError::Expired);
                    }
                }
            }
        }
        Ok(row)
    }
    pub(crate) async fn production_reserve(
        &self,
        candidate: &RunAdmissionResult,
        key: &str,
    ) -> Result<DispatchClaimResult> {
        if !valid(key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let row = self
            .production_authorized_run(&mut tx, &candidate.provider)
            .await?;
        if candidate.provider.run.purpose != AdmissionPurpose::Execution {
            return Err(RuntimeStoreError::Fenced);
        }
        if candidate.run_state != RunState::Starting {
            return Err(RuntimeStoreError::Conflict);
        }
        match row.get::<&str, _>("dispatch_state") {
            "delivery_unknown" | "quarantined" => {
                return Ok(DispatchClaimResult::ReconciliationRequired)
            }
            _ => {}
        }
        if candidate.disposition != AdmissionDisposition::FreshCandidate {
            return Ok(DispatchClaimResult::Replay);
        }
        let token = candidate
            .candidate_key
            .as_deref()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or(RuntimeStoreError::InvalidInput)?;
        if row.get::<Option<String>, _>("candidate_hash")
            != Some(hash("production-candidate-v1", &[token]))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        if row.get::<&str, _>("dispatch_state") == "reserved" {
            if row.get::<Option<String>, _>("reserve_key").as_deref() != Some(key) {
                return Err(RuntimeStoreError::Conflict);
            }
            return Ok(DispatchClaimResult::Replay);
        }
        let reservation = secret();
        ledger::reserve(
            &mut tx,
            Ledger::Production,
            &candidate.provider.run.run_id.to_string(),
            &hash("production-reservation-v1", &[&reservation]),
            key,
        )
        .await?;
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("reserve-before-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("reserve-before-commit").await?;
        tx.commit().await.map_err(db)?;
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("reserve-after-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("reserve-after-commit").await?;
        Ok(DispatchClaimResult::Reserved(Box::new(DispatchClaim {
            provider: candidate.provider.clone(),
            reservation_key: reservation,
        })))
    }
    pub(crate) async fn production_consume(
        &self,
        claim: &DispatchClaim,
    ) -> Result<DispatchConsumption> {
        Ok(match self.consume_execution(claim).await? {
            ExecutionConsumption::Dispatch(_) => DispatchConsumption::DispatchNow,
            ExecutionConsumption::ReconciliationRequired => {
                DispatchConsumption::ReconciliationRequired
            }
        })
    }
    /// Trusted runtime/Executor bridge. Caller text cannot replace durable message
    /// input. Lost reply leaves DeliveryUnknown and no replacement capability.
    pub async fn consume_execution(&self, claim: &DispatchClaim) -> Result<ExecutionConsumption> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let row = self
            .production_authorized_run(&mut tx, &claim.provider)
            .await?;
        if claim.provider.run.purpose != AdmissionPurpose::Execution {
            return Err(RuntimeStoreError::Fenced);
        }
        match row.get::<&str, _>("dispatch_state") {
            "delivery_unknown" | "quarantined" => {
                return Ok(ExecutionConsumption::ReconciliationRequired)
            }
            "reserved" => {}
            _ => return Err(RuntimeStoreError::Conflict),
        }
        if claim.reservation_key.len() != 64
            || !claim.reservation_key.bytes().all(|b| b.is_ascii_hexdigit())
            || row.get::<Option<String>, _>("reservation_hash")
                != Some(hash("production-reservation-v1", &[&claim.reservation_key]))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let context = self.context()?;
        let message_id: String = row.get("message_id");
        let text = match self.worker_task_input_in(&mut tx, &row).await? {
            Some(instructions) => instructions,
            None => sqlx::query_scalar(
                "SELECT text FROM messages WHERE id=? AND owner_id=? AND conversation_id=?",
            )
            .bind(&message_id)
            .bind(context.owner.to_string())
            .bind(claim.provider.run.conversation_id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?,
        };
        // A timer occurrence executes in Deep only. Its Fast presentation keeps
        // the window's Fast lifecycle but never receives the scheduled
        // instructions, so they cannot run (or cause side effects) twice.
        let text = if claim.provider.run.role == orkestr_v2_contracts::runtime::Role::Fast
            && sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM dormant_timer_inputs WHERE message_id=?",
            )
            .bind(&message_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?
                != 0
        {
            FAST_TIMER_TEXT.to_owned()
        } else {
            text
        };
        let parent_run = match row.get::<Option<String>, _>("worker_delegation_id") {
            Some(delegation) => {
                let parent: String = sqlx::query_scalar(
                    "SELECT parent_run_id FROM worker_provider_delegations WHERE id=? AND admitted_run_id=?",
                ).bind(delegation).bind(claim.provider.run.run_id.to_string())
                 .fetch_one(&mut *tx).await.map_err(db)?;
                Some(orkestr_v2_contracts::RunId(parent.parse().map_err(db)?))
            }
            None => None,
        };
        let launch = match claim.provider.run.role {
            orkestr_v2_contracts::runtime::Role::Fast => {
                crate::conversation_resources::fast_settings::turn_launch(
                    &mut tx,
                    &claim.provider.run.conversation_id,
                )
                .await
                .map_err(|_| RuntimeStoreError::Unavailable)?
            }
            _ => Some(
                crate::conversation_resources::settings::turn_launch(
                    &mut tx,
                    &claim.provider.run.conversation_id,
                )
                .await
                .map_err(|_| RuntimeStoreError::Unavailable)?,
            ),
        };
        // Fast gets the chat rules inline (no forced tool call per reply), but
        // only when the final turn still fits the provider input bound;
        // otherwise the savepoint drops that attempt and Fast keeps the line.
        // A warm same-window Fast continuation already received this exact
        // rules version earlier in its session: say so instead of inlining the
        // file again (or prompting a re-read), so the session does not grow by
        // one copy of the rules per reply.
        // Only the same native thread counts (a fresh native under the same
        // binding has no such history), never a timer turn (it saw only the
        // fixed note), and only while this version is inlinable, so the
        // earlier turn received the content rather than just the read line.
        let text = if claim.provider.run.role == orkestr_v2_contracts::runtime::Role::Fast {
            match super::fast_rules::leading_line(&text) {
                Some(line)
                    if super::fast_rules::inline(text.clone()) != text
                        && sqlx::query_scalar::<_, i64>("SELECT count(*) FROM production_runs r JOIN messages m ON m.id=r.message_id WHERE r.session_id=? AND r.native_session_id=? AND r.id!=? AND r.role='fast' AND NOT EXISTS(SELECT 1 FROM dormant_timer_inputs t WHERE t.event_id=r.event_id) AND substr(m.text,1,?)=?")
                        .bind(claim.provider.run.session_id.to_string())
                        .bind(claim.provider.run.native_session_id.clone())
                        .bind(claim.provider.run.run_id.to_string())
                        .bind(i64::try_from(line.chars().count() + 1).map_err(db)?)
                        .bind(format!("{line}\n"))
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(db)?
                        != 0 =>
                {
                    super::fast_rules::already_given(text)
                }
                _ => text,
            }
        } else {
            text
        };
        let inlined = (claim.provider.run.role == orkestr_v2_contracts::runtime::Role::Fast)
            .then(|| super::fast_rules::inline(text.clone()))
            .filter(|inlined| *inlined != text);
        let mut final_text = None;
        if let Some(inlined) = inlined {
            sqlx::query("SAVEPOINT fast_rules_inline")
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            let attached = self
                .attach_turn_context(&mut tx, &claim.provider, &row, inlined)
                .await?;
            if super::fast_rules::fits(&attached) {
                sqlx::query("RELEASE fast_rules_inline")
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
                final_text = Some(attached);
            } else {
                sqlx::query("ROLLBACK TO fast_rules_inline")
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
                sqlx::query("RELEASE fast_rules_inline")
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
            }
        }
        let text = match final_text {
            Some(text) => text,
            None => {
                self.attach_turn_context(&mut tx, &claim.provider, &row, text)
                    .await?
            }
        };
        let capability = ConsumedProviderDispatch {
            launch,
            parent_run,
            provider: claim.provider.clone(),
            message_id: orkestr_v2_contracts::MessageId(Uuid::parse_str(&message_id).map_err(db)?),
            source_event_id: orkestr_v2_contracts::EventId(
                row.get::<String, _>("event_id").parse().map_err(db)?,
            ),
            text,
            namespace: context.namespace.clone(),
            incarnation: context.incarnation.clone(),
        };
        let won = ledger::consume(
            &mut tx,
            Ledger::Production,
            &claim.provider.run.run_id.to_string(),
        )
        .await?;
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("consume-before-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("consume-before-commit").await?;
        tx.commit().await.map_err(db)?;
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("consume-after-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("consume-after-commit").await?;
        Ok(if won {
            ExecutionConsumption::Dispatch(Box::new(capability))
        } else {
            ExecutionConsumption::ReconciliationRequired
        })
    }
}

/// Fast presentation of a timer occurrence: no scheduled instructions.
pub const FAST_TIMER_TEXT: &str =
    "[Scheduled timer occurrence. The Deep turn executes it; this Fast turn \
must not run any command or tool and must not act on it. Reply with exactly NO_REPLY.]";
