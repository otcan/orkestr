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
impl Store {
    /// Commits a deduplicated due occurrence and advances cadence atomically.
    /// The receipt is provenance only; it is not a native/provider admission.
    pub async fn claim_dormant_timer(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &TimerClaimRequest,
        now_ms: i64,
    ) -> Result<TimerClaimReceipt> {
        if request.namespace.is_nil() || request.generation < 1 || !valid(&request.request_key, 128)
        {
            return Err(HistoryError::Invalid);
        }
        schedule::clock(now_ms)?;
        schedule::clock(request.due_ms)?;
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let current = row(&mut tx, owner, request.namespace).await?;
        let result = receipt(&current)?;
        if !matches!(result.state, TimerState::Enabled | TimerState::Exhausted)
            || result.generation != request.generation
        {
            return Err(HistoryError::Conflict);
        }
        let conversation = ConversationId(
            Uuid::parse_str(current.get::<&str, _>("conversation_id")).map_err(unavailable)?,
        );
        target(&mut tx, owner, &conversation).await?;
        if let Some(old) = sqlx::query(
            "SELECT * FROM dormant_timer_claims WHERE owner_id=? AND namespace=? AND request_key=?",
        )
        .bind(owner.to_string())
        .bind(request.namespace.to_string())
        .bind(&request.request_key)
        .fetch_optional(&mut *tx)
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
            tx.commit().await.map_err(unavailable)?;
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
            Some(schedule::next(&schedule, now_ms)?)
        };
        let claim_id = Uuid::new_v4();
        sqlx::query("INSERT INTO dormant_timer_claims(owner_id,namespace,request_key,generation,due_ms,claim_id,conversation_id,source_digest) VALUES(?,?,?,?,?,?,?,?)")
            .bind(owner.to_string()).bind(request.namespace.to_string()).bind(&request.request_key).bind(request.generation).bind(request.due_ms).bind(claim_id.to_string()).bind(conversation.to_string()).bind(&result.source_digest).execute(&mut *tx).await.map_err(unavailable)?;
        sqlx::query(
            "UPDATE dormant_timers SET state=?,next_due_ms=? WHERE owner_id=? AND namespace=?",
        )
        .bind(if next.is_some() {
            "enabled"
        } else {
            "exhausted"
        })
        .bind(next)
        .bind(owner.to_string())
        .bind(request.namespace.to_string())
        .execute(&mut *tx)
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
        tx.commit().await.map_err(unavailable)?;
        Ok(claim)
    }
}
