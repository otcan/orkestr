use super::*;

fn claim_receipt(row: &SqliteRow) -> Result<TimerClaimReceipt> {
    Ok(TimerClaimReceipt {
        claim_id: Uuid::parse_str(row.get("claim_id")).map_err(unavailable)?,
        namespace: Uuid::parse_str(row.get("namespace")).map_err(unavailable)?,
        generation: row.get("generation"),
        due_ms: row.get("due_ms"),
        conversation_id: ConversationId(
            Uuid::parse_str(row.get("conversation_id")).map_err(unavailable)?,
        ),
        source_digest: row.get("source_digest"),
    })
}
pub(super) async fn in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TimerClaimRequest,
    now_ms: i64,
) -> Result<TimerClaimReceipt> {
    claim_in_transaction(tx, owner, request, now_ms, false).await
}

/// Only a fully fenced scan-result transaction may advance an action timer.
pub(super) async fn scan_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TimerClaimRequest,
    now_ms: i64,
) -> Result<TimerClaimReceipt> {
    claim_in_transaction(tx, owner, request, now_ms, true).await
}

async fn claim_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TimerClaimRequest,
    now_ms: i64,
    scan_action: bool,
) -> Result<TimerClaimReceipt> {
    if request.namespace.is_nil() || request.generation < 1 || !valid(&request.request_key, 128) {
        return Err(HistoryError::Invalid);
    }
    schedule::clock(now_ms)?;
    schedule::clock(request.due_ms)?;
    let current = row(tx, owner, request.namespace).await?;
    let result = receipt(&current)?;
    if !matches!(result.state, TimerState::Enabled | TimerState::Exhausted)
        || result.generation != request.generation
    {
        return Err(HistoryError::Conflict);
    }
    let scan:i64=sqlx::query_scalar("SELECT count(*) FROM tracker_scan_authorities WHERE owner_id=? AND namespace=? AND generation=?")
        .bind(owner.to_string()).bind(request.namespace.to_string()).bind(request.generation)
        .fetch_one(&mut **tx).await.map_err(unavailable)?;
    if (scan != 0) != scan_action {
        return Err(HistoryError::Conflict);
    }
    let conversation = ConversationId(
        Uuid::parse_str(current.get::<&str, _>("conversation_id")).map_err(unavailable)?,
    );
    target(tx, owner, &conversation).await?;
    if let Some(old) = sqlx::query(
        "SELECT * FROM dormant_timer_claims WHERE owner_id=? AND namespace=? AND request_key=?",
    )
    .bind(owner.to_string())
    .bind(request.namespace.to_string())
    .bind(&request.request_key)
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?
    {
        if old.get::<i64, _>("cancelled") != 0
            || old.get::<i64, _>("generation") != request.generation
            || old.get::<i64, _>("due_ms") != request.due_ms
        {
            return Err(HistoryError::Conflict);
        }
        let claim = claim_receipt(&old)?;
        return Ok(claim);
    }
    if result.state != TimerState::Enabled
        || result.next_due_ms != Some(request.due_ms)
        || now_ms < request.due_ms
    {
        return Err(HistoryError::Conflict);
    }
    let schedule = schedule::decode(current.get("schedule_json"))?;
    let next = if matches!(schedule, TimerSchedule::Once { .. }) {
        None
    } else {
        let natural = schedule::next(&schedule, now_ms)?;
        Some(
            policy_pause::adjust_next(
                tx,
                owner,
                request.namespace,
                &schedule,
                &conversation.to_string(),
                natural,
            )
            .await?,
        )
    };
    let claim_id = Uuid::new_v4();
    sqlx::query("INSERT INTO dormant_timer_claims(owner_id,namespace,request_key,generation,due_ms,claim_id,conversation_id,source_digest) VALUES(?,?,?,?,?,?,?,?)")
            .bind(owner.to_string()).bind(request.namespace.to_string()).bind(&request.request_key).bind(request.generation).bind(request.due_ms).bind(claim_id.to_string()).bind(conversation.to_string()).bind(&result.source_digest).execute(&mut **tx).await.map_err(unavailable)?;
    sqlx::query("UPDATE dormant_timers SET state=?,next_due_ms=? WHERE owner_id=? AND namespace=?")
        .bind(if next.is_some() {
            "enabled"
        } else {
            "exhausted"
        })
        .bind(next)
        .bind(owner.to_string())
        .bind(request.namespace.to_string())
        .execute(&mut **tx)
        .await
        .map_err(unavailable)?;
    let claim = TimerClaimReceipt {
        claim_id,
        namespace: request.namespace,
        generation: request.generation,
        due_ms: request.due_ms,
        conversation_id: conversation,
        source_digest: result.source_digest,
    };
    Ok(claim)
}
impl Store {
    /// Records inert provenance only. The ordinary-input bridge is a separate API.
    pub async fn claim_dormant_timer(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &TimerClaimRequest,
        now_ms: i64,
    ) -> Result<TimerClaimReceipt> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let receipt = in_transaction(&mut tx, owner, request, now_ms).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(receipt)
    }
}

/// A trigger-event occurrence: claimed at `due_ms` (the event time) without
/// touching the schedule, so event runs never move or double the clock cadence.
pub(super) async fn event_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TimerClaimRequest,
    now_ms: i64,
) -> Result<TimerClaimReceipt> {
    if request.namespace.is_nil() || request.generation < 1 || !valid(&request.request_key, 128) {
        return Err(HistoryError::Invalid);
    }
    schedule::clock(now_ms)?;
    schedule::clock(request.due_ms)?;
    let current = row(tx, owner, request.namespace).await?;
    let result = receipt(&current)?;
    if result.state != TimerState::Enabled || result.generation != request.generation {
        return Err(HistoryError::Conflict);
    }
    let conversation = ConversationId(
        Uuid::parse_str(current.get::<&str, _>("conversation_id")).map_err(unavailable)?,
    );
    target(tx, owner, &conversation).await?;
    if let Some(old) = sqlx::query(
        "SELECT * FROM dormant_timer_claims WHERE owner_id=? AND namespace=? AND request_key=?",
    )
    .bind(owner.to_string())
    .bind(request.namespace.to_string())
    .bind(&request.request_key)
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?
    {
        if old.get::<i64, _>("cancelled") != 0
            || old.get::<i64, _>("generation") != request.generation
        {
            return Err(HistoryError::Conflict);
        }
        return claim_receipt(&old);
    }
    let claim_id = Uuid::new_v4();
    sqlx::query("INSERT INTO dormant_timer_claims(owner_id,namespace,request_key,generation,due_ms,claim_id,conversation_id,source_digest) VALUES(?,?,?,?,?,?,?,?)")
        .bind(owner.to_string()).bind(request.namespace.to_string()).bind(&request.request_key).bind(request.generation).bind(request.due_ms).bind(claim_id.to_string()).bind(conversation.to_string()).bind(&result.source_digest).execute(&mut **tx).await.map_err(unavailable)?;
    Ok(TimerClaimReceipt {
        claim_id,
        namespace: request.namespace,
        generation: request.generation,
        due_ms: request.due_ms,
        conversation_id: conversation,
        source_digest: result.source_digest,
    })
}
