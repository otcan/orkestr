//! Explicit owner action authority, mutually exclusive with model instructions.
use super::*;

fn receipt(row: &SqliteRow, duplicate: bool) -> Result<TrackerScanAuthority> {
    Ok(TrackerScanAuthority {
        authority_id: Uuid::parse_str(row.get("authority_id")).map_err(unavailable)?,
        namespace: Uuid::parse_str(row.get("namespace")).map_err(unavailable)?,
        generation: row.get("generation"),
        conversation_id: ConversationId(
            Uuid::parse_str(row.get("conversation_id")).map_err(unavailable)?,
        ),
        source_revision: row.get("source_revision"),
        recipe_id: row.get("recipe_id"),
        classifier_digest: row.get("classifier_digest"),
        duplicate,
    })
}
pub(super) async fn enable_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TrackerScanEnable,
    now: i64,
) -> Result<TrackerScanAuthority> {
    // Historical receipt first: source changes/Stop never turn its replay
    // into a replacement enable or a refreshed read capability.
    if let Some(old) = sqlx::query(
        "SELECT * FROM tracker_scan_authorities WHERE owner_id=? AND namespace=? AND request_key=?",
    )
    .bind(owner.to_string())
    .bind(request.timer.namespace.to_string())
    .bind(&request.timer.request_key)
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?
    {
        if old.get::<String, _>("conversation_id") != request.timer.conversation_id.to_string()
            || old.get::<i64, _>("expected_revision") != request.timer.expected_revision
            || old.get::<i64, _>("source_revision") != request.expected_source_revision
            || old.get::<String, _>("recipe_id") != request.expected_recipe
            || old.get::<String, _>("classifier_id") != request.classifier_id
            || old.get::<String, _>("classifier_digest") != request.classifier_digest
        {
            return Err(HistoryError::Conflict);
        }
        let result = receipt(&old, true)?;
        return Ok(result);
    }
    if request.expected_source_revision < 1
        || !valid(&request.expected_recipe, 80)
        || !valid(&request.classifier_id, 80)
        || !rule_digest_valid(&request.classifier_digest)
    {
        return Err(HistoryError::Invalid);
    }
    let source = sqlx::query("SELECT s.source_digest,s.selection_json FROM tracker_source_selections s JOIN trackers t ON t.owner_id=s.owner_id AND t.conversation_id=s.conversation_id AND t.source_revision=s.source_revision AND t.source_json=s.selection_json WHERE s.owner_id=? AND s.conversation_id=? AND s.source_revision=? AND t.recipe=? AND s.acknowledged=1")
        .bind(owner.to_string()).bind(request.timer.conversation_id.to_string()).bind(request.expected_source_revision).bind(&request.expected_recipe)
        .fetch_optional(&mut **tx).await.map_err(unavailable)?.ok_or(HistoryError::Conflict)?;
    let selected: SelectedMailSource =
        serde_json::from_str(source.get("selection_json")).map_err(unavailable)?;
    if !selected.is_valid() || source_digest(&selected)? != source.get::<String, _>("source_digest")
    {
        return Err(HistoryError::Conflict);
    }
    let stored_timer = row(tx, owner, request.timer.namespace).await?;
    if matches!(
        schedule::decode(stored_timer.get("schedule_json"))?,
        TimerSchedule::Event | TimerSchedule::Dormant { .. }
    ) {
        return Err(HistoryError::Invalid);
    }
    let enabled = input::enable_in_transaction(tx, owner, &request.timer, now).await?;
    if enabled.duplicate {
        return Err(HistoryError::Conflict);
    }
    let stop: i64 = sqlx::query_scalar("SELECT stop_sequence FROM dormant_timer_input_guards WHERE owner_id=? AND namespace=? AND generation=? AND conversation_id=?")
        .bind(owner.to_string()).bind(request.timer.namespace.to_string()).bind(enabled.receipt.generation).bind(request.timer.conversation_id.to_string())
        .fetch_one(&mut **tx).await.map_err(unavailable)?;
    let authority = Uuid::new_v4();
    sqlx::query("INSERT INTO tracker_scan_authorities(owner_id,namespace,generation,conversation_id,authority_id,request_key,expected_revision,source_revision,source_digest,recipe_id,classifier_id,classifier_digest,stop_sequence,created_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(owner.to_string()).bind(request.timer.namespace.to_string()).bind(enabled.receipt.generation).bind(request.timer.conversation_id.to_string())
        .bind(authority.to_string()).bind(&request.timer.request_key).bind(request.timer.expected_revision).bind(request.expected_source_revision)
        .bind(source.get::<String,_>("source_digest")).bind(&request.expected_recipe).bind(&request.classifier_id).bind(&request.classifier_digest).bind(stop).bind(now)
        .execute(&mut **tx).await.map_err(unavailable)?;
    Ok(TrackerScanAuthority {
        authority_id: authority,
        namespace: request.timer.namespace,
        generation: enabled.receipt.generation,
        conversation_id: request.timer.conversation_id.clone(),
        source_revision: request.expected_source_revision,
        recipe_id: request.expected_recipe.clone(),
        classifier_digest: request.classifier_digest.clone(),
        duplicate: false,
    })
}
impl Store {
    pub async fn enable_tracker_scan_timer(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &TrackerScanEnable,
    ) -> Result<TrackerScanAuthority> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let now = store_clock(&mut tx).await?;
        let result = enable_in_transaction(&mut tx, owner, request, now).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    pub async fn timer_work_kind(
        &self,
        issuer: &crate::TimerSchedulerIssuer,
        namespace: Uuid,
    ) -> Result<TimerWorkKind> {
        let (mut tx, owner) = self.timer_scheduler_transaction(issuer, namespace).await?;
        let result = row(&mut tx, &owner, namespace).await?;
        let generation: i64 = result.get("generation");
        let instruction: i64 = sqlx::query_scalar("SELECT count(*) FROM durable_timer_authorities WHERE owner_id=? AND namespace=? AND generation=?")
            .bind(owner.to_string()).bind(namespace.to_string()).bind(generation).fetch_one(&mut *tx).await.map_err(unavailable)?;
        let scan: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_scan_authorities WHERE owner_id=? AND namespace=? AND generation=?")
            .bind(owner.to_string()).bind(namespace.to_string()).bind(generation).fetch_one(&mut *tx).await.map_err(unavailable)?;
        let kind = match (instruction, scan) {
            (1, 0) => TimerWorkKind::Instruction,
            (0, 1) => TimerWorkKind::TrackerScan,
            _ => return Err(HistoryError::Conflict),
        };
        tx.commit().await.map_err(unavailable)?;
        Ok(kind)
    }
}
