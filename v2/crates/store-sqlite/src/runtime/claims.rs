use super::*;
use orkestr_v2_contracts::{EventId, MessageId};

pub(super) async fn next(
    store: &Store,
    owner: &OwnerId,
    conversation: &ConversationId,
    consumer: &SessionId,
    duration: Duration,
) -> Result<Option<InboxClaim>> {
    if duration < Duration::from_secs(1) || duration > Duration::from_secs(60) {
        return Err(RuntimeStoreError::InvalidInput);
    }
    let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
    store.check_context_in(&mut tx, owner).await?;
    scope(&mut tx, owner, conversation).await?;
    let valid: i64 = sqlx::query_scalar("SELECT count(*) FROM session_bindings WHERE id=? AND owner_id=? AND conversation_id=? AND role='deep' AND state IN ('starting','ready','busy')")
        .bind(consumer.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .fetch_one(&mut *tx).await.map_err(db)?;
    // A parallel Deep slot claims only through `claim_parallel_deep_input`.
    if valid != 1
        || crate::production_runtime::parallel_deep::is_slot(&mut tx, &consumer.to_string()).await?
    {
        return Err(RuntimeStoreError::NotFound);
    }
    // The canonical lineage never waits behind an input a parallel slot
    // claimed (it is consumed at that slot's admission). With no slot
    // (always, while the owner's switch is off) this selects exactly the
    // same row as before.
    let slots = crate::production_runtime::parallel_deep::present(&mut tx).await?;
    let skip = if slots {
        format!(
            " AND NOT {}",
            crate::production_runtime::parallel_deep::claimed_by_other_slot("reasoning_inbox")
        )
    } else {
        String::new()
    };
    let now: i64 =
        sqlx::query_scalar("SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
    let window = store
        .execution_window_input_in(&mut tx, conversation, None)
        .await?;
    // Do not skip an outstanding earlier admitted claim to take a later follow-up.
    let sql = format!("SELECT * FROM reasoning_inbox WHERE conversation_id=? AND state IN ('queued','claimed') AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=reasoning_inbox.event_id) AND (? IS NULL OR EXISTS(SELECT 1 FROM execution_window_inputs wi WHERE wi.window_id=? AND wi.event_id=reasoning_inbox.event_id)){skip} ORDER BY sequence LIMIT 1");
    let mut select = sqlx::query(&sql)
        .bind(conversation.to_string())
        .bind(&window)
        .bind(&window);
    if slots {
        select = select.bind(consumer.to_string());
    }
    let row = select.fetch_optional(&mut *tx).await.map_err(db)?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.get::<&str, _>("state") == "claimed"
        && row
            .get::<Option<i64>, _>("claim_deadline_ms")
            .is_some_and(|deadline| deadline > now)
    {
        return Err(RuntimeStoreError::Busy);
    }
    let sequence: i64 = row.get("sequence");
    // A fresh owner message may be the first part of one thought WhatsApp
    // split into several: its Deep turn waits until the burst is quiet, then
    // takes all of it (deep_groups). Nothing is claimed meanwhile; the
    // session polls again. Fast never reads the inbox and is not delayed.
    if row.get::<&str, _>("state") == "queued"
        && crate::production_runtime::deep_groups::settling(
            &mut tx,
            conversation,
            sequence,
            window.as_deref(),
            store.deep_burst_quiet_ms,
            now,
        )
        .await?
    {
        return Ok(None);
    }
    let generation = row
        .get::<i64, _>("claim_generation")
        .checked_add(1)
        .ok_or(RuntimeStoreError::Unavailable)?;
    let deadline = now
        .checked_add(i64::try_from(duration.as_millis()).map_err(db)?)
        .ok_or(RuntimeStoreError::InvalidInput)?;
    sqlx::query("UPDATE reasoning_inbox SET state='claimed',claimant_session_id=?,claim_generation=?,claim_deadline_ms=? WHERE conversation_id=? AND sequence=?")
        .bind(consumer.to_string()).bind(generation).bind(deadline).bind(conversation.to_string()).bind(sequence)
        .execute(&mut *tx).await.map_err(db)?;
    let result = InboxClaim {
        owner_id: owner.clone(),
        conversation_id: conversation.clone(),
        consumer_session_id: consumer.clone(),
        message_id: MessageId(id(row.get("message_id"))?),
        event_id: EventId(id(row.get("event_id"))?),
        scope_sequence: sequence,
        claim_generation: u64::try_from(generation).map_err(db)?,
        lease_deadline_ms: deadline,
    };
    tx.commit().await.map_err(db)?;
    Ok(Some(result))
}
