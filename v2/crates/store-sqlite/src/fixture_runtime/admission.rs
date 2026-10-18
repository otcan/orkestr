use super::*;
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::SessionId;
use sqlx::sqlite::SqliteRow;

pub(super) use crate::runtime::envelope::run_state;
pub(super) use crate::runtime::ledger::{hash, secret};
pub(super) fn envelope(row: &SqliteRow) -> Result<ProviderAdmission> {
    crate::runtime::envelope::envelope(row, ProviderKind::ExplicitFixture)
}

impl FixtureSupervisorStore {
    pub(super) async fn admit(
        &self,
        claim: &InboxClaim,
        binding_id: &SessionId,
        expected_generation: u64,
        request_key: &str,
    ) -> Result<RunAdmissionResult> {
        if claim.owner_id != self.owner {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if !valid(request_key)
            || claim.scope_sequence <= 0
            || claim.claim_generation == 0
            || i64::try_from(claim.claim_generation).is_err()
            || expected_generation == 0
            || i64::try_from(expected_generation).is_err()
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        if *binding_id != claim.consumer_session_id {
            return Err(RuntimeStoreError::Conflict);
        }
        let digest = crate::runtime::ledger::input_digest(
            claim,
            binding_id,
            expected_generation,
            request_key,
        );
        let mut tx = self
            .store
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        self.validate_in(&mut tx).await?;
        // Authenticate scope before exposing any replay receipt. Old context cannot
        // attach another namespace's run even when all caller-supplied IDs match.
        crate::runtime::scope(&mut tx, &self.owner, &claim.conversation_id).await?;
        if let Some(row) = sqlx::query(
            "SELECT * FROM fixture_runs WHERE owner_id=? AND conversation_id=? AND request_key=?",
        )
        .bind(self.owner.to_string())
        .bind(claim.conversation_id.to_string())
        .bind(request_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        {
            if row.get::<String, _>("context_id") != self.context_id.to_string() {
                return Err(RuntimeStoreError::Unauthorized);
            }
            if row.get::<String, _>("input_digest") != digest {
                return Err(RuntimeStoreError::Conflict);
            }
            let result = RunAdmissionResult {
                provider: envelope(&row)?,
                run_state: run_state(&row),
                disposition: if row.get::<&str, _>("dispatch_state") == "candidate"
                    && row.get::<String, _>("incarnation_id") == self.incarnation_id.to_string()
                {
                    AdmissionDisposition::Replay
                } else {
                    AdmissionDisposition::ReconciliationRequired
                },
                candidate_key: None,
            };
            tx.commit().await.map_err(db)?;
            return Ok(result);
        }
        let occupied: i64 =
            sqlx::query_scalar("SELECT count(*) FROM fixture_runs WHERE session_id=?")
                .bind(binding_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if occupied != 0 {
            return Err(RuntimeStoreError::Busy);
        }
        let clock = now(&mut tx).await?;
        crate::runtime::ledger::validate_claim(&mut tx, claim, binding_id, clock).await?;
        let row = sqlx::query("SELECT b.* FROM session_bindings b JOIN fixture_readiness r ON r.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND r.context_id=? AND r.incarnation_id=? AND r.protocol_version=1 AND b.provider_kind='explicit_fixture' AND b.provider_namespace=?")
            .bind(binding_id.to_string()).bind(self.owner.to_string()).bind(claim.conversation_id.to_string())
            .bind(self.context_id.to_string()).bind(self.incarnation_id.to_string()).bind(&self.namespace)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Unavailable)?;
        let binding = crate::runtime::binding(&row)?;
        if binding.role != Role::Deep || binding.parent_session_id.is_some() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        if binding.generation != expected_generation {
            return Err(RuntimeStoreError::StaleLease);
        }
        if binding.state != SessionState::Ready {
            return Err(RuntimeStoreError::Busy);
        }
        let native = binding
            .native_session_id
            .ok_or(RuntimeStoreError::Unavailable)?;
        let supervisor_deadline: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms FROM fixture_supervisors WHERE context_id=?",
        )
        .bind(self.context_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let deadline = claim.lease_deadline_ms.min(supervisor_deadline);
        let candidate = secret();
        let verifier = hash("fixture-candidate-v1", &[&candidate]);
        let run_id = Uuid::new_v4();
        let run = sqlx::query("INSERT INTO fixture_runs(id,context_id,incarnation_id,owner_id,conversation_id,session_id,native_session_id,binding_generation,message_id,event_id,scope_sequence,claim_generation,request_key,input_digest,lease_generation,dispatch_fence,lease_deadline_ms,attempt,state,dispatch_state,candidate_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,1,'starting','candidate',?) RETURNING *")
            .bind(run_id.to_string()).bind(self.context_id.to_string()).bind(self.incarnation_id.to_string())
            .bind(self.owner.to_string()).bind(claim.conversation_id.to_string()).bind(binding_id.to_string())
            .bind(native).bind(i64::try_from(binding.generation).map_err(db)?)
            .bind(claim.message_id.to_string()).bind(claim.event_id.to_string()).bind(claim.scope_sequence)
            .bind(i64::try_from(claim.claim_generation).map_err(db)?).bind(request_key).bind(digest)
            .bind(self.generation).bind(deadline).bind(verifier).fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query(
            "INSERT INTO fixture_run_leases(run_id,generation,lease_deadline_ms,dispatch_fence) VALUES(?,?,?,?)",
        )
        .bind(run_id.to_string())
        .bind(1_i64)
        .bind(deadline)
        .bind(self.generation)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        #[cfg(feature = "fixture-test-controls")]
        self.fixture_checkpoint("admit-before-ack").await?;
        sqlx::query("UPDATE reasoning_inbox SET state='consumed',admitted_fixture_run_id=? WHERE conversation_id=? AND sequence=?")
            .bind(run_id.to_string()).bind(claim.conversation_id.to_string()).bind(claim.scope_sequence)
            .execute(&mut *tx).await.map_err(db)?;
        sqlx::query("UPDATE session_bindings SET state='busy' WHERE id=?")
            .bind(binding_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let result = RunAdmissionResult {
            provider: envelope(&run)?,
            run_state: RunState::Starting,
            disposition: AdmissionDisposition::FreshCandidate,
            candidate_key: Some(candidate),
        };
        #[cfg(test)]
        super::crash_tests::checkpoint("admit-before-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.fixture_checkpoint("admit-before-commit").await?;
        tx.commit().await.map_err(db)?;
        #[cfg(test)]
        super::crash_tests::checkpoint("admit-after-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.fixture_checkpoint("admit-after-commit").await?;
        Ok(result)
    }
}
