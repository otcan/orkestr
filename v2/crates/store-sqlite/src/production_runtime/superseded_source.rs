//! ORK-795: a queued source continuation (for example an automatic host
//! result handed back to the run that issued it) whose source binding has
//! moved on can never be dispatched: `source_continuation::validate` refuses
//! it for good, because a later run already used the source session (or the
//! provider generation or binding changed). Admission used to report that as
//! a refused admission, which ended the whole execution window and released
//! every other input waiting in it: owner follow-ups, timer firings and other
//! results. Only that one input is retired here, with an immutable retirement
//! receipt (reason `source_superseded`), and the window takes its next input.
//! Nothing is replayed, no run is created and the source fence is unchanged.
use super::*;
use orkestr_v2_contracts::{OwnerInputRetirementReceipt, OwnerInputRetirementState};

pub(crate) const SUPERSEDED_SOURCE_REASON: &str = "source_superseded";

impl Store {
    /// Retire the exact live claim `claim` when, and only when, its source
    /// continuation fence no longer holds. `Ok(true)`: retired now, and the
    /// caller may claim the next input. `Ok(false)`: the input has no fence,
    /// its fence still holds, or the claim is no longer exactly this one; the
    /// caller's own refusal stands and nothing changed.
    pub async fn retire_superseded_source_claim(&self, claim: &InboxClaim) -> Result<bool> {
        let c = self.context()?;
        if claim.owner_id != c.owner {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let claim_generation = i64::try_from(claim.claim_generation).map_err(db)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        crate::runtime::scope(&mut tx, &c.owner, &claim.conversation_id).await?;
        // This claim, still held by the same consumer and claim generation,
        // never admitted, with no run of any kind, and fenced to a source run.
        let claimed: i64 = sqlx::query_scalar("SELECT count(*) FROM reasoning_inbox i JOIN messages m ON m.id=i.message_id JOIN source_admission_fences f ON f.message_id=m.id WHERE i.conversation_id=? AND i.sequence=? AND i.message_id=? AND i.event_id=? AND i.state='claimed' AND i.claimant_session_id=? AND i.claim_generation=? AND i.admitted_run_id IS NULL AND i.admitted_fixture_run_id IS NULL AND m.owner_id=? AND m.conversation_id=i.conversation_id AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.event_id=i.event_id OR r.message_id=i.message_id) AND NOT EXISTS(SELECT 1 FROM fixture_runs r WHERE r.event_id=i.event_id OR r.message_id=i.message_id)")
            .bind(claim.conversation_id.to_string()).bind(claim.scope_sequence)
            .bind(claim.message_id.to_string()).bind(claim.event_id.to_string())
            .bind(claim.consumer_session_id.to_string()).bind(claim_generation)
            .bind(c.owner.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if claimed != 1 {
            return Ok(false);
        }
        // The same check admission makes. Only an actual source mismatch
        // settles the input; a storage failure changes nothing.
        match crate::source_continuation::validate(
            &mut tx,
            &c.owner,
            &claim.conversation_id,
            &claim.message_id,
        )
        .await
        {
            Ok(()) => return Ok(false),
            Err(crate::StoreError::ProviderGenerationMismatch) => {}
            Err(_) => return Err(RuntimeStoreError::Unavailable),
        }
        let clock = now(&mut tx).await?;
        let receipt = OwnerInputRetirementReceipt {
            retirement_id: Uuid::new_v4(),
            conversation_id: claim.conversation_id.clone(),
            message_id: claim.message_id.clone(),
            event_id: claim.event_id.clone(),
            scope_sequence: claim.scope_sequence,
            reason: SUPERSEDED_SOURCE_REASON.to_owned(),
            state: OwnerInputRetirementState::Retired,
            retired_at_ms: clock,
            duplicate: false,
        };
        sqlx::query("INSERT INTO owner_input_retirements(id,owner_id,conversation_id,message_id,event_id,scope_sequence,request_key,reason,retired_at_ms,receipt_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
            .bind(receipt.retirement_id.to_string()).bind(c.owner.to_string())
            .bind(claim.conversation_id.to_string()).bind(claim.message_id.to_string())
            .bind(claim.event_id.to_string()).bind(claim.scope_sequence)
            .bind(format!("source-superseded:{}", claim.event_id.0))
            .bind(SUPERSEDED_SOURCE_REASON).bind(clock)
            .bind(serde_json::to_string(&receipt).map_err(db)?)
            .execute(&mut *tx).await.map_err(db)?;
        let changed = sqlx::query("UPDATE reasoning_inbox SET state='retired',claimant_session_id=NULL,claim_deadline_ms=NULL WHERE conversation_id=? AND sequence=? AND event_id=? AND state='claimed' AND claimant_session_id=? AND claim_generation=?")
            .bind(claim.conversation_id.to_string()).bind(claim.scope_sequence)
            .bind(claim.event_id.to_string()).bind(claim.consumer_session_id.to_string())
            .bind(claim_generation)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        Ok(true)
    }
}
