//! Text an agent set for its own timer while one of that timer's runs was
//! still unfinished (ORK-756). A new generation would fence that run, so the
//! text is recorded against the generation it was set in: the next firing of
//! that generation uses the newest row, and a later generation never sees it.
use super::authority::instruction_digest;
use super::*;

/// The text this generation's next firing receives: its newest recorded
/// update, or else `granted`, the generation's own instruction.
pub(super) async fn effective_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    generation: i64,
    granted: String,
) -> Result<String> {
    let update = sqlx::query("SELECT instruction,instruction_digest FROM agent_timer_instruction_updates WHERE owner_id=? AND namespace=? AND generation=? ORDER BY sequence DESC LIMIT 1")
        .bind(owner.to_string()).bind(namespace.to_string()).bind(generation)
        .fetch_optional(&mut **tx).await.map_err(unavailable)?;
    let Some(update) = update else {
        return Ok(granted);
    };
    let text: String = update.get("instruction");
    if instruction_digest(&text) != update.get::<String, _>("instruction_digest") {
        return Err(HistoryError::Conflict);
    }
    Ok(text)
}

/// Record `instruction` as what this generation's next firing receives.
pub(super) async fn record_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    generation: i64,
    request_key: &str,
    instruction: &str,
    now_ms: i64,
) -> Result<()> {
    if instruction.trim().is_empty() || instruction.len() > 32768 {
        return Err(HistoryError::Invalid);
    }
    sqlx::query("INSERT INTO agent_timer_instruction_updates(owner_id,namespace,generation,request_key,instruction,instruction_digest,created_ms) VALUES(?,?,?,?,?,?,?)")
        .bind(owner.to_string()).bind(namespace.to_string()).bind(generation)
        .bind(request_key).bind(instruction).bind(instruction_digest(instruction)).bind(now_ms)
        .execute(&mut **tx).await.map_err(unavailable)?;
    Ok(())
}
