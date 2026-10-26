use super::*;

fn semantic(action: &str, expected: i64, conversation: Option<&ConversationId>) -> String {
    hash(
        &serde_json::json!([
            "orkestr.timer.control.v1",
            action,
            expected,
            conversation.map(ToString::to_string)
        ])
        .to_string(),
    )
}
async fn prior(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    key: &str,
) -> Result<Option<SqliteRow>> {
    sqlx::query(
        "SELECT * FROM dormant_timer_controls WHERE owner_id=? AND namespace=? AND request_key=?",
    )
    .bind(owner.to_string())
    .bind(namespace.to_string())
    .bind(key)
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)
}
fn check(namespace: Uuid, expected: i64, key: &str) -> Result<()> {
    if namespace.is_nil() || expected < 1 || !valid(key, 128) {
        return Err(HistoryError::Invalid);
    }
    Ok(())
}
fn replay(
    current: &SqliteRow,
    prior: &SqliteRow,
    digest: &str,
    state: TimerState,
) -> Result<TimerReceipt> {
    if prior.get::<String, _>("semantic_digest") != digest {
        return Err(HistoryError::Conflict);
    }
    let mut result = receipt(current)?;
    // Never reissue stale generation authority after control, even identical key.
    if result.state != state
        || result.generation != prior.get::<i64, _>("generation")
        || result.revision != prior.get::<i64, _>("receipt_revision")
    {
        return Err(HistoryError::Conflict);
    }
    result.next_due_ms = prior.get("due_ms");
    Ok(result)
}
pub(super) async fn enable_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TimerEnableRequest,
    now_ms: i64,
) -> Result<TimerReceipt> {
    check(
        request.namespace,
        request.expected_revision,
        &request.request_key,
    )?;
    schedule::clock(now_ms)?;
    target(tx, owner, &request.conversation_id).await?;
    let current = row(tx, owner, request.namespace).await?;
    let digest = semantic(
        "enable",
        request.expected_revision,
        Some(&request.conversation_id),
    );
    if let Some(old) = prior(tx, owner, request.namespace, &request.request_key).await? {
        let result = replay(&current, &old, &digest, TimerState::Enabled)?;
        return Ok(result);
    }
    let result = receipt(&current)?;
    // A timer moved into a specific conversation can only be enabled there.
    let mapped: Option<String> = sqlx::query_scalar(
        "SELECT conversation_id FROM dormant_timer_targets WHERE owner_id=? AND namespace=?",
    )
    .bind(owner.to_string())
    .bind(request.namespace.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?;
    if mapped.is_some_and(|id| id != request.conversation_id.to_string()) {
        return Err(HistoryError::Conflict);
    }
    if !matches!(result.state, TimerState::Paused | TimerState::Disabled)
        || result.revision != request.expected_revision
        || result.dormant_reason.is_some()
    {
        return Err(HistoryError::Conflict);
    }
    let schedule = schedule::decode(current.get("schedule_json"))?;
    let due = schedule::next_for(&schedule, request.namespace, now_ms)?;
    let due = policy_pause::adjust_next(
        tx,
        owner,
        request.namespace,
        &schedule,
        &request.conversation_id.to_string(),
        due,
    )
    .await?;
    let rev = revision(result.revision)?;
    let generation = revision(result.generation)?;
    sqlx::query("UPDATE dormant_timers SET state='enabled',revision=?,generation=?,conversation_id=?,next_due_ms=? WHERE owner_id=? AND namespace=?")
            .bind(rev).bind(generation).bind(request.conversation_id.to_string()).bind(due).bind(owner.to_string()).bind(request.namespace.to_string()).execute(&mut **tx).await.map_err(unavailable)?;
    sqlx::query("INSERT INTO dormant_timer_controls(owner_id,namespace,request_key,semantic_digest,action,receipt_revision,generation,conversation_id,due_ms) VALUES(?,?,?,?,'enable',?,?,?,?)")
            .bind(owner.to_string()).bind(request.namespace.to_string()).bind(&request.request_key).bind(digest).bind(rev).bind(generation).bind(request.conversation_id.to_string()).bind(due).execute(&mut **tx).await.map_err(unavailable)?;
    let result = receipt(&row(tx, owner, request.namespace).await?)?;
    Ok(result)
}
pub(super) async fn control_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TimerControlRequest,
) -> Result<TimerReceipt> {
    check(
        request.namespace,
        request.expected_revision,
        &request.request_key,
    )?;
    let current = row(tx, owner, request.namespace).await?;
    let (action, state) = request.action.values();
    let digest = semantic(action, request.expected_revision, None);
    if let Some(old) = prior(tx, owner, request.namespace, &request.request_key).await? {
        let result = replay(&current, &old, &digest, TimerState::parse(state)?)?;
        return Ok(result);
    }
    let result = receipt(&current)?;
    if result.revision != request.expected_revision
        || matches!(result.state, TimerState::Stopped | TimerState::RolledBack)
    {
        return Err(HistoryError::Conflict);
    }
    let rev = revision(result.revision)?;
    let generation = revision(result.generation)?;
    sqlx::query("UPDATE dormant_timer_claims SET cancelled=1 WHERE owner_id=? AND namespace=?")
        .bind(owner.to_string())
        .bind(request.namespace.to_string())
        .execute(&mut **tx)
        .await
        .map_err(unavailable)?;
    sqlx::query("UPDATE dormant_timers SET state=?,revision=?,generation=?,next_due_ms=NULL WHERE owner_id=? AND namespace=?")
        .bind(state).bind(rev).bind(generation).bind(owner.to_string()).bind(request.namespace.to_string()).execute(&mut **tx).await.map_err(unavailable)?;
    sqlx::query("INSERT INTO dormant_timer_controls(owner_id,namespace,request_key,semantic_digest,action,receipt_revision,generation) VALUES(?,?,?,?,?,?,?)")
        .bind(owner.to_string()).bind(request.namespace.to_string()).bind(&request.request_key).bind(digest).bind(action).bind(rev).bind(generation).execute(&mut **tx).await.map_err(unavailable)?;
    let result = receipt(&row(tx, owner, request.namespace).await?)?;
    Ok(result)
}
impl Store {
    /// Enables schedule provenance only; use enable_timer_input for ordinary input.
    pub async fn enable_dormant_timer(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &TimerEnableRequest,
        now_ms: i64,
    ) -> Result<TimerReceipt> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let receipt = enable_in_transaction(&mut tx, owner, request, now_ms).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(receipt)
    }
    /// Terminal Stop/rollback cannot be resurrected. Disable needs a NEW explicit
    /// enable key/revision/generation. All controls retain provenance and claims.
    pub async fn control_dormant_timer(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &TimerControlRequest,
    ) -> Result<TimerReceipt> {
        check(
            request.namespace,
            request.expected_revision,
            &request.request_key,
        )?;
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let result = control_in_transaction(&mut tx, owner, request).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}
