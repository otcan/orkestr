use super::*;
use orkestr_v2_contracts::SessionId;
use sqlx::sqlite::SqliteRow;

use crate::runtime::envelope::run_state;
use crate::runtime::ledger::{hash, secret};
pub(super) fn envelope(row: &SqliteRow) -> Result<ProviderAdmission> {
    let kind = match row.get::<&str, _>("provider_kind") {
        "codex" => ProviderKind::Codex,
        "claude" => ProviderKind::Claude,
        _ => return Err(RuntimeStoreError::Unavailable),
    };
    crate::runtime::envelope::envelope(row, kind)
}

impl Store {
    pub(crate) async fn production_admit(
        &self,
        claim: &InboxClaim,
        binding_id: &SessionId,
        expected_generation: u64,
        request_key: &str,
    ) -> Result<RunAdmissionResult> {
        if claim.owner_id != self.context()?.owner {
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
        let c = self.context()?;
        let digest = crate::runtime::ledger::input_digest(
            claim,
            binding_id,
            expected_generation,
            request_key,
        );
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.authenticate(&mut tx).await?;
        // Authenticate scope before exposing any replay receipt. Old context cannot
        // attach another namespace's run even when all caller-supplied IDs match.
        crate::runtime::scope(&mut tx, &c.owner, &claim.conversation_id).await?;
        if let Some(row) = sqlx::query(
            "SELECT * FROM production_runs WHERE owner_id=? AND conversation_id=? AND request_key=?",
        )
        .bind(c.owner.to_string())
        .bind(claim.conversation_id.to_string())
        .bind(request_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        {
            if row.get::<String, _>("context_id") != c.id {
                return Err(RuntimeStoreError::Unauthorized);
            }
            if row.get::<String, _>("input_digest") != digest {
                return Err(RuntimeStoreError::Conflict);
            }
            let result = RunAdmissionResult {
                provider: envelope(&row)?,
                run_state: run_state(&row),
                disposition: if row.get::<&str, _>("dispatch_state") == "candidate"
                    && row.get::<String, _>("incarnation_id") == c.incarnation
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
        c.validate(&mut tx).await?;
        let occupied: i64 =
            sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE session_id=?")
                .bind(binding_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if occupied != 0 {
            return Err(RuntimeStoreError::Busy);
        }
        let clock = now(&mut tx).await?;
        crate::runtime::ledger::validate_claim(&mut tx, claim, binding_id, clock).await?;
        let row = sqlx::query("SELECT b.* FROM session_bindings b JOIN production_readiness r ON r.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND r.context_id=? AND r.incarnation_id=? AND b.provider_kind=? AND b.provider_namespace=?")
            .bind(binding_id.to_string()).bind(c.owner.to_string()).bind(claim.conversation_id.to_string())
            .bind(&c.id).bind(&c.incarnation).bind(provider_name(c.provider)?).bind(&c.namespace)
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
            "SELECT lease_deadline_ms FROM production_supervisors WHERE context_id=?",
        )
        .bind(&c.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let deadline = claim.lease_deadline_ms.min(supervisor_deadline);
        let candidate = secret();
        let verifier = hash("production-candidate-v1", &[&candidate]);
        let run_id = Uuid::new_v4();
        let run = sqlx::query("INSERT INTO production_runs(id,context_id,incarnation_id,owner_id,conversation_id,session_id,native_session_id,provider_kind,binding_generation,message_id,event_id,scope_sequence,claim_generation,request_key,input_digest,lease_generation,dispatch_fence,lease_deadline_ms,attempt,state,dispatch_state,candidate_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,1,'starting','candidate',?) RETURNING *")
            .bind(run_id.to_string()).bind(&c.id).bind(&c.incarnation)
            .bind(c.owner.to_string()).bind(claim.conversation_id.to_string()).bind(binding_id.to_string())
            .bind(native).bind(provider_name(c.provider)?).bind(i64::try_from(binding.generation).map_err(db)?)
            .bind(claim.message_id.to_string()).bind(claim.event_id.to_string()).bind(claim.scope_sequence)
            .bind(i64::try_from(claim.claim_generation).map_err(db)?).bind(request_key).bind(digest)
            .bind(c.generation).bind(deadline).bind(verifier).fetch_one(&mut *tx).await.map_err(db)?;
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("admit-before-ack");
        sqlx::query("UPDATE reasoning_inbox SET state='consumed',admitted_run_id=? WHERE conversation_id=? AND sequence=?")
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
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("admit-before-commit");
        tx.commit().await.map_err(db)?;
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("admit-after-commit");
        Ok(result)
    }
}
