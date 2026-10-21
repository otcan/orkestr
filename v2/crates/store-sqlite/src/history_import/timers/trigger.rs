//! Event-triggered timer runs: a new inbound message or email starts a run
//! instead of polling. The owner-side API only records a durable event; the
//! timer supervisor admits it under the same grant, Stop fence and pause rules
//! as a clock occurrence. Bursts coalesce into one run, optionally spaced by a
//! minimum interval.
use super::authority::{instruction_digest, store_clock};
use super::input::{self, TimerInputReceipt, TimerInputRequest};
use super::policy::{TriggerSource, FOREVER_MS};
use super::{policy, schedule, *};

fn event_key_ok(key: &str) -> bool {
    valid(key, 128)
}

impl Store {
    /// Record an inbound event for every enabled trigger timer of the
    /// conversation that listens to `source`. Returns the number of timers that
    /// newly accepted it; a replay of the same `event_key` returns 0.
    pub async fn record_timer_trigger(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        source: TriggerSource,
        event_key: &str,
    ) -> Result<u32> {
        if !event_key_ok(event_key) {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, true).await?;
        target(&mut tx, owner, conversation).await?;
        let now_ms = store_clock(&mut tx).await?;
        let timers = sqlx::query("SELECT p.namespace,p.trigger_json FROM timer_policies p JOIN dormant_timers t ON t.owner_id=p.owner_id AND t.namespace=p.namespace WHERE p.owner_id=? AND t.conversation_id=? AND t.state='enabled' AND p.trigger_json IS NOT NULL")
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        let mut accepted = 0;
        for timer in timers {
            let config: policy::TriggerConfig =
                serde_json::from_str(timer.get("trigger_json")).map_err(unavailable)?;
            if !config.sources.contains(&source) {
                continue;
            }
            let changed = sqlx::query("INSERT OR IGNORE INTO timer_trigger_events(owner_id,namespace,event_key,source,received_ms,state) VALUES(?,?,?,?,?,'pending')")
                .bind(owner.to_string()).bind(timer.get::<String, _>("namespace")).bind(event_key)
                .bind(source.text()).bind(now_ms)
                .execute(&mut *tx).await.map_err(unavailable)?
                .rows_affected();
            accepted += u32::try_from(changed).unwrap_or(0);
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(accepted)
    }
}

/// Timers with pending events, for the supervisor's discovery pass.
pub(crate) async fn pending_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    limit: u16,
) -> Result<Vec<Uuid>> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT DISTINCT namespace FROM timer_trigger_events WHERE owner_id=? AND state='pending' ORDER BY namespace LIMIT ?")
        .bind(owner.to_string()).bind(i64::from(limit))
        .fetch_all(&mut **tx).await.map_err(unavailable)?;
    rows.iter()
        .map(|id| Uuid::parse_str(id).map_err(unavailable))
        .collect()
}

async fn settle_all(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    state: &str,
    claim: Option<Uuid>,
) -> Result<()> {
    sqlx::query("UPDATE timer_trigger_events SET state=?,claim_id=? WHERE owner_id=? AND namespace=? AND state='pending'")
        .bind(state).bind(claim.map(|c| c.to_string())).bind(owner.to_string()).bind(namespace.to_string())
        .execute(&mut **tx).await.map_err(unavailable)?;
    Ok(())
}

/// Admit one run for all pending events of a timer. `Ok(None)` means nothing
/// ran: events were suppressed (paused, disabled, no grant) or are waiting out
/// the minimum interval.
pub(crate) async fn admit_pending_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    now_ms: i64,
) -> Result<Option<TimerInputReceipt>> {
    let current = row(tx, owner, namespace).await?;
    let timer = receipt(&current)?;
    let policy_row = policy::read_in(tx, owner, namespace).await?;
    let (Some(trigger), TimerState::Enabled) = (policy_row.trigger.as_ref(), timer.state) else {
        settle_all(tx, owner, namespace, "suppressed", None).await?;
        return Ok(None);
    };
    let grant = sqlx::query(
        "SELECT * FROM durable_timer_authorities WHERE owner_id=? AND namespace=? AND generation=?",
    )
    .bind(owner.to_string())
    .bind(namespace.to_string())
    .bind(timer.generation)
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?;
    let Some(grant) = grant else {
        settle_all(tx, owner, namespace, "suppressed", None).await?;
        return Ok(None);
    };
    let instruction: String = grant.get("instruction");
    if instruction_digest(&instruction) != grant.get::<String, _>("instruction_digest")
        || grant.get::<String, _>("conversation_id") != current.get::<String, _>("conversation_id")
    {
        return Err(HistoryError::Conflict);
    }
    let conversation: String = current.get("conversation_id");
    let decoded = schedule::decode(current.get("schedule_json"))?;
    let supp = policy_pause::load(tx, owner, namespace, &decoded, Some(&conversation)).await?;
    // Events during a pause or on a skipped day are dropped, not queued for later.
    if supp.until >= FOREVER_MS || supp.blocks(now_ms) {
        settle_all(tx, owner, namespace, "suppressed", None).await?;
        return Ok(None);
    }
    let last: Option<i64> = sqlx::query_scalar("SELECT max(c.due_ms) FROM timer_trigger_events e JOIN dormant_timer_claims c ON c.claim_id=e.claim_id WHERE e.owner_id=? AND e.namespace=? AND e.state='admitted'")
        .bind(owner.to_string()).bind(namespace.to_string())
        .fetch_one(&mut **tx).await.map_err(unavailable)?;
    if last.is_some_and(|at| now_ms.saturating_sub(at) < i64::from(trigger.min_interval_s) * 1000) {
        return Ok(None);
    }
    let events = sqlx::query("SELECT event_key,source FROM timer_trigger_events WHERE owner_id=? AND namespace=? AND state='pending' ORDER BY received_ms,event_key")
        .bind(owner.to_string()).bind(namespace.to_string())
        .fetch_all(&mut **tx).await.map_err(unavailable)?;
    let Some(first) = events.first() else {
        return Ok(None);
    };
    let first_key: String = first.get("event_key");
    let source: String = first.get("source");
    let mut due = now_ms;
    loop {
        let taken: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_claims WHERE owner_id=? AND namespace=? AND generation=? AND due_ms=?")
            .bind(owner.to_string()).bind(namespace.to_string()).bind(timer.generation).bind(due)
            .fetch_one(&mut **tx).await.map_err(unavailable)?;
        if taken == 0 {
            break;
        }
        due += 1;
    }
    let text = format!(
        "{instruction}\n\n[Trigger: new inbound {source} event{}]",
        if events.len() > 1 {
            format!(" (+{} more since the last run)", events.len() - 1)
        } else {
            String::new()
        }
    );
    let request = TimerInputRequest {
        claim: TimerClaimRequest {
            namespace,
            generation: timer.generation,
            due_ms: due,
            request_key: format!("event:{}:{}", timer.generation, &hash(&first_key)[..40]),
        },
        text,
    };
    let admitted = input::admit_event_in_transaction(tx, owner, &request, now_ms).await?;
    sqlx::query("UPDATE timer_trigger_events SET state='admitted',claim_id=? WHERE owner_id=? AND namespace=? AND event_key=?")
        .bind(admitted.claim.claim_id.to_string()).bind(owner.to_string()).bind(namespace.to_string()).bind(&first_key)
        .execute(&mut **tx).await.map_err(unavailable)?;
    settle_all(
        tx,
        owner,
        namespace,
        "coalesced",
        Some(admitted.claim.claim_id),
    )
    .await?;
    Ok(Some(admitted))
}
