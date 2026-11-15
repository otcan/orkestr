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
