//! ORK-798: operator settlement of an automatic result that can never run.
//!
//! An automatic result (a host tool result fenced to the Deep turn that asked
//! for it, `source_admission_fences`) that a window released when it ended
//! was left behind in two shapes before the ORK-783 fix (243 rows on
//! 2026-11-12):
//!
//! - claimed by a Deep session whose claim lapsed while its window closed.
//!   Reconciliation releases the input but keeps it `claimed`; Core claims
//!   only inputs of the current window and only a `queued` result is queued
//!   again, so it never runs and is never retired;
//! - still queued after its own Fast run finished (Fast once ran on every
//!   input). A result with any run is never queued again.
//!
//! The owner retire route refuses both, correctly for ordinary input: one is
//! claimed, the other has a run. This route settles exactly these shapes
//! with the ordinary immutable retirement receipt (reason
//! [`STALE_INPUT_SETTLEMENT_REASON`]), so they stop counting as eligible
//! input (`/held-inputs`, conversation status, steering order). It needs the
//! owner's own browser session; a service or machine session is refused.
//!
//! It refuses (409, nothing written) unless all of these hold in one
//! `BEGIN IMMEDIATE` transaction:
//! - the input is an owner-actor automatic result with a source fence;
//! - its window queue intent was dispatched to a window that is `closed`,
//!   and it is not a member of any window that is not closed;
//! - it was never admitted; every run of it is a Fast run that finished
//!   (`succeeded`, `failed` or `cancelled`), and no fixture run exists;
//! - it is `claimed` with a lapsed claim, or `queued` and unclaimed with a
//!   finished Fast run.
//!
//! Nothing is replayed or sent; no run, window or message is created, and a
//! Stop hold stays a hold. The same request key returns the same receipt.
use super::*;
use orkestr_v2_contracts::{
    ConversationId, EventId, MessageId, OwnerInputRetirementReceipt, OwnerInputRetirementState,
    StaleInputSettlementRequest, STALE_INPUT_SETTLEMENT_REASON,
};

/// The input `?1` (event) / `?2` (message) is a stale automatic result at
/// clock `?3`. Closed constant SQL; every value is bound.
const STALE: &str = "SELECT count(*) FROM reasoning_inbox i JOIN messages m ON m.id=i.message_id AND m.conversation_id=i.conversation_id JOIN source_admission_fences f ON f.message_id=i.message_id JOIN execution_window_queue q ON q.event_id=i.event_id AND q.message_id=i.message_id AND q.state='dispatched' JOIN execution_windows w ON w.id=q.window_id AND w.conversation_id=i.conversation_id AND w.state='closed' WHERE i.event_id=?1 AND i.message_id=?2 AND m.actor_kind='owner' AND i.admitted_run_id IS NULL AND i.admitted_fixture_run_id IS NULL AND ((i.state='claimed' AND i.claim_deadline_ms IS NOT NULL AND i.claim_deadline_ms<=?3) OR (i.state='queued' AND i.claimant_session_id IS NULL AND EXISTS(SELECT 1 FROM production_runs r WHERE (r.event_id=i.event_id OR r.message_id=i.message_id) AND r.role='fast'))) AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE (r.event_id=i.event_id OR r.message_id=i.message_id) AND (r.role!='fast' OR r.state NOT IN ('succeeded','failed','cancelled'))) AND NOT EXISTS(SELECT 1 FROM fixture_runs r WHERE r.event_id=i.event_id OR r.message_id=i.message_id) AND NOT EXISTS(SELECT 1 FROM execution_window_inputs wi JOIN execution_windows live ON live.id=wi.window_id WHERE (wi.event_id=i.event_id OR wi.message_id=i.message_id) AND live.state!='closed')";

impl Store {
    /// Settle one exact stale automatic result with an immutable
    /// `operator_settled_stale` retirement receipt. `Conflict` when the input
    /// is not in exactly that shape (or the key names another decision).
    pub async fn settle_stale_input_for_browser(
        &self,
        credential: &str,
        conversation: &ConversationId,
        message: &MessageId,
        request: &StaleInputSettlementRequest,
    ) -> Result<OwnerInputRetirementReceipt> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if conversation.0.is_nil() || message.0.is_nil() || !request.is_valid() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        // Only the owner's own interactive session: never an adapter's
        // service session or a machine token.
        let owner: String = sqlx::query_scalar("SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch() AND kind='browser' AND service_credential_id IS NULL")
            .bind(crate::digest(credential))
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(RuntimeStoreError::Unauthorized)?;
        let owner = OwnerId(owner.parse().map_err(db)?);
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let old = sqlx::query("SELECT message_id,reason,receipt_json FROM owner_input_retirements WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(row) = old {
            if row.get::<String, _>("message_id") != message.to_string()
                || row.get::<String, _>("reason") != STALE_INPUT_SETTLEMENT_REASON
            {
                return Err(RuntimeStoreError::Conflict);
            }
            let mut receipt: OwnerInputRetirementReceipt =
                serde_json::from_str(row.get("receipt_json")).map_err(db)?;
            receipt.duplicate = true;
            return Ok(receipt);
        }
        let input = super::retired_inputs::inbox_row(&mut tx, &owner, conversation, message)
            .await?
            .ok_or(RuntimeStoreError::NotFound)?;
        let event: String = input.get("event_id");
        let clock = now(&mut tx).await?;
        let stale: i64 = sqlx::query_scalar(STALE)
            .bind(&event)
            .bind(message.to_string())
            .bind(clock)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if stale != 1 {
            return Err(RuntimeStoreError::Conflict);
        }
        let receipt = OwnerInputRetirementReceipt {
            retirement_id: Uuid::new_v4(),
            conversation_id: conversation.clone(),
            message_id: message.clone(),
            event_id: EventId(event.parse().map_err(db)?),
            scope_sequence: input.get("sequence"),
            reason: STALE_INPUT_SETTLEMENT_REASON.to_owned(),
            state: OwnerInputRetirementState::Retired,
            retired_at_ms: clock,
            duplicate: false,
        };
        sqlx::query("INSERT INTO owner_input_retirements(id,owner_id,conversation_id,message_id,event_id,scope_sequence,request_key,reason,retired_at_ms,receipt_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
            .bind(receipt.retirement_id.to_string()).bind(owner.to_string())
            .bind(conversation.to_string()).bind(message.to_string()).bind(&event)
            .bind(receipt.scope_sequence).bind(&request.request_key)
            .bind(STALE_INPUT_SETTLEMENT_REASON).bind(clock)
            .bind(serde_json::to_string(&receipt).map_err(db)?)
            .execute(&mut *tx).await.map_err(db)?;
        // Exactly the row that was checked: same state and claim generation.
        let changed = sqlx::query("UPDATE reasoning_inbox SET state='retired',claimant_session_id=NULL,claim_deadline_ms=NULL WHERE event_id=? AND state=? AND claim_generation=? AND admitted_run_id IS NULL AND admitted_fixture_run_id IS NULL")
            .bind(&event)
            .bind(input.get::<String, _>("state"))
            .bind(input.get::<i64, _>("claim_generation"))
            .execute(&mut *tx)
            .await
            .map_err(db)?
            .rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Conflict);
        }
        tx.commit().await.map_err(db)?;
        Ok(receipt)
    }
}
