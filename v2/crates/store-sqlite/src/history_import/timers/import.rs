use super::*;

/// Domain-separated, length-unambiguous source schedule provenance fingerprint.
/// This is not the Python projection/envelope digest or a workload-content hash.
pub fn timer_source_digest(request: &TimerImportRequest) -> Result<String> {
    if request.namespace.is_nil()
        || !valid(&request.source_namespace, 128)
        || !valid(&request.source_timer_id, 128)
    {
        return Err(HistoryError::Invalid);
    }
    let encoded = schedule::encode(&request.schedule)?;
    Ok(hash(
        &serde_json::json!([
            "orkestr.timer.source.v1",
            request.source_namespace,
            request.source_timer_id,
            request.source_enabled,
            encoded
        ])
        .to_string(),
    ))
}
impl Store {
    /// Exact provenance replay never re-enables, resurrects or creates native input.
    pub async fn import_dormant_timer(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &TimerImportRequest,
    ) -> Result<TimerReceipt> {
        let digest = timer_source_digest(request)?;
        let encoded = schedule::encode(&request.schedule)?;
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let existing = sqlx::query("SELECT * FROM dormant_timers WHERE owner_id=? AND (namespace=? OR (source_namespace=? AND source_timer_id=?))")
            .bind(owner.to_string()).bind(request.namespace.to_string()).bind(&request.source_namespace).bind(&request.source_timer_id)
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        if !existing.is_empty() {
            if existing.len() != 1 {
                return Err(HistoryError::Conflict);
            }
            let stored = &existing[0];
            if stored.get::<String, _>("namespace") != request.namespace.to_string()
                || stored.get::<String, _>("source_digest") != digest
                || stored.get::<String, _>("schedule_json") != encoded
            {
                return Err(HistoryError::Conflict);
            }
            // Current receipt, explicitly NOT an authority to enable or claim.
            let result = receipt(stored)?;
            tx.commit().await.map_err(unavailable)?;
            return Ok(result);
        }
        sqlx::query("INSERT INTO dormant_timers(owner_id,namespace,source_namespace,source_timer_id,source_enabled,source_digest,schedule_json,state,dormant_reason,revision,generation) VALUES(?,?,?,?,?,?,?,'paused',?,1,0)")
            .bind(owner.to_string()).bind(request.namespace.to_string()).bind(&request.source_namespace).bind(&request.source_timer_id).bind(request.source_enabled).bind(digest).bind(encoded).bind(schedule::reason(&request.schedule))
            .execute(&mut *tx).await.map_err(unavailable)?;
        let result = receipt(&row(&mut tx, owner, request.namespace).await?)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
    pub async fn dormant_timer_receipt(
        &self,
        credential: &str,
        owner: &OwnerId,
        namespace: Uuid,
    ) -> Result<TimerReceipt> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        let result = receipt(&row(&mut tx, owner, namespace).await?)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}
