//! ORK-837: what a standing operator provider-policy handoff waits for, and
//! what it settles in its own transaction.
//!
//! The policy source was queued because it matched while a window was still
//! active. Every input queued behind it (host results, timer firings, owner
//! follow-ups) inherits that match and waits for the switch. The owner's
//! explicit handoff requires an empty conversation queue, which these inputs
//! can never provide: they drain only after the switch. The policy handoff
//! therefore waits only for work that is ahead of, or in flight with, its
//! source:
//!
//! - an inbox row a session claimed;
//! - a queued window intent queued before the source's own intent (every
//!   queued intent when the source has none);
//! - an inbox row bound to a window that is not closed.
//!
//! Successors stay queued and are admitted in their order after the switch.
//!
//! A successor fenced to a run of the previous provider generation (a host
//! result handed back to the Deep turn that asked for it,
//! `source_admission_fences`) can never run after the switch: no session of
//! the new provider issued that call, and its fence no longer matches the
//! conversation's provider generation. Dispatch would withdraw it on its next
//! pass (ORK-783). Here it is withdrawn (`input_unavailable`) and its input
//! retired with the ordinary `source_superseded` receipt in the handoff
//! transaction itself, and the caller gets each event to alert on.
//!
//! An inbox row without a queued intent and outside every unclosed window
//! (for example an input whose window admission was never requested) is
//! neither ahead nor in flight: no window claims it and no dispatcher admits
//! it. It is left exactly as it is, for a later admission or the owner's
//! retire route.
use super::*;

/// Work ahead of or in flight with the source `?3` in conversation `?1` of
/// owner `?2`. Closed constant SQL; every value is bound.
const BLOCKING: &str = "SELECT (SELECT count(*) FROM reasoning_inbox WHERE conversation_id=?1 AND state='claimed' AND message_id!=?3)+(SELECT count(*) FROM execution_window_queue q WHERE q.owner_id=?2 AND q.conversation_id=?1 AND q.state='queued' AND q.message_id!=?3 AND q.position<coalesce((SELECT min(s.position) FROM execution_window_queue s WHERE s.owner_id=?2 AND s.conversation_id=?1 AND s.state='queued' AND s.message_id=?3),9223372036854775807))+(SELECT count(*) FROM reasoning_inbox i JOIN execution_window_inputs wi ON wi.event_id=i.event_id JOIN execution_windows w ON w.id=wi.window_id WHERE i.conversation_id=?1 AND i.state IN ('queued','claimed') AND w.state!='closed')";

pub(super) async fn blocking(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    source: &MessageId,
) -> Result<i64> {
    sqlx::query_scalar(BLOCKING)
        .bind(conversation.to_string())
        .bind(owner.to_string())
        .bind(source.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)
}

/// Called after the switch's settings write, in its transaction: withdraw
/// every queued successor fenced to an earlier provider generation than
/// `provider_generation` and retire its input. Returns the withdrawn events
/// in queue order.
pub(super) async fn withdraw_superseded(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    source: &MessageId,
    provider_generation: i64,
) -> Result<Vec<EventId>> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT q.request_key,q.event_id FROM execution_window_queue q JOIN source_admission_fences f ON f.message_id=q.message_id WHERE q.owner_id=? AND q.conversation_id=? AND q.state='queued' AND q.message_id!=? AND f.expected_provider_generation!=? ORDER BY q.position")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(source.to_string()).bind(provider_generation)
        .fetch_all(&mut *tx).await.map_err(db)?;
    let mut withdrawn = Vec::with_capacity(rows.len());
    for (request_key, event) in rows {
        let changed = sqlx::query("UPDATE execution_window_queue SET state='withdrawn',withdrawal='input_unavailable' WHERE owner_id=? AND conversation_id=? AND request_key=? AND state='queued'")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&request_key)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        // The same settlement dispatch makes for a withdrawn continuation
        // whose fence fails. A held input stays held (and unretired).
        crate::production_runtime::superseded_source::retire_superseded_queued_in(
            tx,
            owner,
            conversation,
            &event,
        )
        .await?;
        withdrawn.push(EventId(event.parse().map_err(db)?));
    }
    Ok(withdrawn)
}

/// The queued intent `?3` (request key) of conversation `?1`, owner `?2`, is
/// a result handed back to a Deep turn (`source_admission_fences`) of a
/// conversation that a standing provider policy matched. Closed constant SQL.
const FENCED_HEAD: &str = "SELECT q.event_id FROM execution_window_queue q JOIN source_admission_fences f ON f.message_id=q.message_id WHERE q.conversation_id=?1 AND q.owner_id=?2 AND q.request_key=?3 AND q.state='queued' AND EXISTS(SELECT 1 FROM conversation_provider_policy_matches p WHERE p.owner_id=q.owner_id AND p.conversation_id=q.conversation_id)";

impl Store {
    /// A standing provider switch can never take a result handed back to a
    /// Deep turn as its source: no session of the target provider issued
    /// that call (`pending_input` refuses it), and the policy no longer lets
    /// the turn's own provider run. Queued ahead of the switch's first
    /// ordinary input, such a result held the whole conversation: dispatch
    /// takes each conversation's head, every pass refused it, and every
    /// input behind it waited for it. The switch withdraws exactly these
    /// results when they queue behind its source (`withdraw_superseded`).
    /// This settles one queued ahead of it the same way: withdrawn as
    /// `input_unavailable`, its input retired with the ordinary
    /// `source_superseded` receipt, in one transaction. Its fence still
    /// holds here, so the retirement does not require it to fail.
    ///
    /// Returns the withdrawn event, or None when the intent is not exactly
    /// such a queued, fenced result of a policy-matched conversation
    /// (nothing is written then).
    pub async fn withdraw_policy_superseded_result_authenticated(
        &self,
        browser: &str,
        conversation: &ConversationId,
        request_key: &str,
    ) -> Result<Option<EventId>> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = super::browser_owner(self, &mut tx, browser).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let event: Option<String> = sqlx::query_scalar(FENCED_HEAD)
            .bind(conversation.to_string())
            .bind(owner.to_string())
            .bind(request_key)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        let Some(event) = event else {
            return Ok(None);
        };
        let changed = sqlx::query("UPDATE execution_window_queue SET state='withdrawn',withdrawal='input_unavailable' WHERE owner_id=? AND conversation_id=? AND request_key=? AND state='queued'")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(request_key)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        // Withdrawn and retired together, or neither: a claimed, held or
        // already run input keeps its queue intent (the transaction drops).
        if !crate::production_runtime::superseded_source::retire_policy_superseded_queued_in(
            &mut tx,
            &owner,
            conversation,
            &event,
        )
        .await?
        {
            return Ok(None);
        }
        tx.commit().await.map_err(db)?;
        Ok(Some(EventId(event.parse().map_err(db)?)))
    }
}
