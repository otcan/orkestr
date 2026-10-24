//! Transaction-time source, timer, pause and Stop fences shared by read/commit.
use super::*;

pub(super) struct Current {
    pub read_policy_id: String,
    pub timer: TimerReceipt,
    pub conversation: ConversationId,
    pub authority_id: Uuid,
    pub source_revision: i64,
    pub source: SelectedMailSource,
    pub recipe_id: String,
    pub classifier_id: String,
    pub classifier_digest: String,
    pub stop_sequence: i64,
}

pub(super) async fn current(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    now: i64,
) -> Result<Current> {
    let stored = row(tx, owner, namespace).await?;
    let timer = receipt(&stored)?;
    if timer.state != TimerState::Enabled || timer.next_due_ms.is_none_or(|due| due > now) {
        return Err(HistoryError::Conflict);
    }
    let conversation =
        ConversationId(Uuid::parse_str(stored.get("conversation_id")).map_err(unavailable)?);
    target(tx, owner, &conversation).await?;
    input::guard(tx, owner, namespace, timer.generation, &conversation).await?;
    let schedule = schedule::decode(stored.get("schedule_json"))?;
    if policy_pause::load(
        tx,
        owner,
        namespace,
        &schedule,
        Some(&conversation.to_string()),
    )
    .await?
    .blocks(timer.next_due_ms.unwrap())
    {
        return Err(HistoryError::Conflict);
    }
    let authority=sqlx::query("SELECT a.*,s.selection_json FROM tracker_scan_authorities a JOIN tracker_source_selections s ON s.owner_id=a.owner_id AND s.conversation_id=a.conversation_id AND s.source_revision=a.source_revision JOIN trackers t ON t.owner_id=s.owner_id AND t.conversation_id=s.conversation_id AND t.source_revision=s.source_revision AND t.source_json=s.selection_json AND t.recipe=a.recipe_id WHERE a.owner_id=? AND a.namespace=? AND a.generation=? AND a.conversation_id=? AND s.acknowledged=1")
        .bind(owner.to_string()).bind(namespace.to_string()).bind(timer.generation).bind(conversation.to_string())
        .fetch_optional(&mut **tx).await.map_err(unavailable)?.ok_or(HistoryError::Conflict)?;
    let source: SelectedMailSource =
        serde_json::from_str(authority.get("selection_json")).map_err(unavailable)?;
    let classifier_digest: String = authority.get("classifier_digest");
    if !source.is_valid()
        || source_digest(&source)? != authority.get::<String, _>("source_digest")
        || !rule_digest_valid(&classifier_digest)
    {
        return Err(HistoryError::Conflict);
    }
    Ok(Current {
        read_policy_id: authority.get("read_policy_id"),
        timer,
        conversation,
        authority_id: Uuid::parse_str(authority.get("authority_id")).map_err(unavailable)?,
        source_revision: authority.get("source_revision"),
        source,
        recipe_id: authority.get("recipe_id"),
        classifier_id: authority.get("classifier_id"),
        classifier_digest,
        stop_sequence: authority.get("stop_sequence"),
    })
}
