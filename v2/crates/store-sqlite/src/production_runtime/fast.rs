//! Fixed-purpose Fast scheduling seam. No Deep claim or Worker delegation.
use super::*;
use orkestr_v2_contracts::{ConversationId, EventId, MessageId, SessionId};

/// Trusted supervisor-selected immutable owner input. No caller text or role.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FastAdmissionInput {
    pub source_message_id: MessageId,
    pub source_event_id: EventId,
    pub fast_binding_id: SessionId,
    pub expected_binding_generation: u64,
    pub request_key: String,
}
impl Store {
    /// Fixed-purpose presentation of exact persisted owner input. No inbox claim
    /// is consumed. Identical admission replay never reissues a dispatch locator.
    pub async fn admit_fast(
        &self,
        credential: &str,
        input: &FastAdmissionInput,
    ) -> Result<RunAdmissionResult> {
        let c = self.context()?;
        if credential.len() != 64
            || !credential.bytes().all(|b| b.is_ascii_hexdigit())
            || crate::digest(credential) != c.token_hash
        {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if input.source_message_id.0.is_nil()
            || input.source_event_id.0.is_nil()
            || input.fast_binding_id.0.is_nil()
            || input.expected_binding_generation == 0
            || i64::try_from(input.expected_binding_generation).is_err()
            || !valid(&input.request_key)
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.authenticate(&mut tx).await?;
        let source = sqlx::query("SELECT e.conversation_id,e.sequence FROM events e JOIN messages m ON m.id=e.message_id WHERE e.id=? AND e.message_id=? AND e.owner_id=? AND m.owner_id=? AND e.conversation_id=m.conversation_id AND e.kind='message_accepted' AND m.actor_kind='owner'")
            .bind(input.source_event_id.to_string()).bind(input.source_message_id.to_string())
            .bind(c.owner.to_string()).bind(c.owner.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        let conversation: String = source.get("conversation_id");
        let digest = crate::runtime::ledger::hash(
            "production-fast-admission-v1",
            &[
                &input.source_message_id.to_string(),
                &input.source_event_id.to_string(),
                &input.fast_binding_id.to_string(),
                &input.expected_binding_generation.to_string(),
                &input.request_key,
            ],
        );
        // Owner-wide source uniqueness prevents a second scheduling key from
        // turning immutable source replay into a second execution.
        if let Some(row) = sqlx::query("SELECT * FROM production_runs WHERE owner_id=? AND ((role='fast' AND event_id=?) OR (conversation_id=? AND request_key=?))")
            .bind(c.owner.to_string()).bind(input.source_event_id.to_string())
            .bind(&conversation).bind(&input.request_key).fetch_optional(&mut *tx).await.map_err(db)? {
            if row.get::<String,_>("context_id") != c.id { return Err(RuntimeStoreError::Unauthorized); }
            if row.get::<&str,_>("role") != "fast" || row.get::<String,_>("input_digest") != digest {
                return Err(RuntimeStoreError::Conflict);
            }
            let result = RunAdmissionResult {
                provider: super::admission::replay_envelope(&mut tx, &row).await?,
                run_state: crate::runtime::envelope::run_state(&row),
                disposition: if row.get::<&str,_>("dispatch_state") == "candidate" && row.get::<String,_>("incarnation_id") == c.incarnation {
                    AdmissionDisposition::Replay
                } else { AdmissionDisposition::ReconciliationRequired },
                candidate_key: None,
            };
            tx.commit().await.map_err(db)?;
            return Ok(result);
        }
        let held: i64 =
            sqlx::query_scalar("SELECT count(*) FROM ordinary_input_holds WHERE event_id=?")
                .bind(input.source_event_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if held != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        c.validate(&mut tx).await?;
        self.execution_window_input_in(
            &mut tx,
            &ConversationId(conversation.parse().map_err(db)?),
            Some(&input.source_event_id),
        )
        .await?;
        let binding_row = sqlx::query("SELECT b.* FROM session_bindings b JOIN production_readiness r ON r.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND r.context_id=? AND r.incarnation_id=? AND b.provider_kind=? AND b.provider_namespace=?")
            .bind(input.fast_binding_id.to_string()).bind(c.owner.to_string()).bind(&conversation)
            .bind(&c.id).bind(&c.incarnation).bind(provider_name(c.provider)?).bind(&c.namespace)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Unavailable)?;
        let binding = crate::runtime::binding(&binding_row)?;
        if binding.role != Role::Fast || binding.parent_session_id.is_some() {
            return Err(RuntimeStoreError::Fenced);
        }
        if binding.generation != input.expected_binding_generation {
            return Err(RuntimeStoreError::StaleLease);
        }
        if binding.state != SessionState::Ready {
            return Err(RuntimeStoreError::Busy);
        }
        super::fast_continuity::require_unused(&mut tx, &binding.session_id).await?;
        let occupied: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE session_id=? AND state NOT IN ('cancelled','succeeded')")
            .bind(input.fast_binding_id.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if occupied != 0 {
            return Err(RuntimeStoreError::Busy);
        }
        let native = binding
            .native_session_id
            .ok_or(RuntimeStoreError::Unavailable)?;
        let deadline: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms FROM production_supervisors WHERE context_id=?",
        )
        .bind(&c.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let candidate = crate::runtime::ledger::secret();
        let verifier = crate::runtime::ledger::hash("production-candidate-v1", &[&candidate]);
        let run_id = Uuid::new_v4();
        let run = sqlx::query("INSERT INTO production_runs(id,context_id,incarnation_id,owner_id,conversation_id,session_id,native_session_id,provider_kind,binding_generation,message_id,event_id,scope_sequence,claim_generation,request_key,input_digest,lease_generation,dispatch_fence,lease_deadline_ms,attempt,state,dispatch_state,candidate_hash,role) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,1,?,?,1,'starting','candidate',?,'fast') RETURNING *")
            .bind(run_id.to_string()).bind(&c.id).bind(&c.incarnation).bind(c.owner.to_string())
            .bind(&conversation).bind(input.fast_binding_id.to_string()).bind(native).bind(provider_name(c.provider)?)
            .bind(i64::try_from(binding.generation).map_err(db)?).bind(input.source_message_id.to_string())
            .bind(input.source_event_id.to_string()).bind(source.get::<i64,_>("sequence"))
            .bind(&input.request_key).bind(digest).bind(c.generation).bind(deadline).bind(verifier)
            .fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO production_run_leases(run_id,generation,lease_deadline_ms,dispatch_fence) VALUES(?,1,?,?)")
            .bind(run_id.to_string()).bind(deadline).bind(c.generation).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("UPDATE session_bindings SET state='busy' WHERE id=?")
            .bind(input.fast_binding_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let result = RunAdmissionResult {
            provider: super::admission::envelope(&run)?,
            run_state: RunState::Starting,
            disposition: AdmissionDisposition::FreshCandidate,
            candidate_key: Some(candidate),
        };
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("admit-before-commit").await?;
        tx.commit().await.map_err(db)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("admit-after-commit").await?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "fast_tests.rs"]
mod tests;
