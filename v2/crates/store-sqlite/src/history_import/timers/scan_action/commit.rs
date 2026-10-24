//! Cursor, classified evidence, canonical occurrence and UI-only digest commit
//! together. There is no reasoning input, native window or chat-delivery queue.
use super::*;
use crate::conversation_resources::ResourceError;
use crate::tracker::{scan, ScannedMessage};

fn resource(error: ResourceError) -> HistoryError {
    match error {
        ResourceError::Unauthorized => HistoryError::Unauthorized,
        ResourceError::NotFound => HistoryError::NotFound,
        ResourceError::Invalid => HistoryError::Invalid,
        ResourceError::Conflict(_) => HistoryError::Conflict,
        ResourceError::Unavailable => HistoryError::Unavailable,
    }
}
fn decode(row: &SqliteRow) -> Result<TrackerScanReceipt> {
    let mut receipt: TrackerScanReceipt =
        serde_json::from_str(row.get("receipt_json")).map_err(unavailable)?;
    receipt.duplicate = true;
    Ok(receipt)
}

impl Store {
    pub async fn commit_tracker_scan(
        &self,
        issuer: &crate::TimerSchedulerIssuer,
        claim: &TrackerScanClaim,
        messages: &[ScannedMessage],
        cursor_json: &str,
        summary_json: &str,
    ) -> Result<TrackerScanReceipt> {
        scan::validate(messages, cursor_json, summary_json).map_err(resource)?;
        if messages.len() > 64
            || messages.iter().any(|m| {
                m.outcome
                    .as_ref()
                    .is_ok_and(|events| events.iter().any(|e| e.classifier != claim.classifier_id))
            })
        {
            return Err(HistoryError::Invalid);
        }
        let digest = hash(
            &serde_json::to_string(&(messages, cursor_json, summary_json)).map_err(unavailable)?,
        );
        let (mut tx, owner) = self
            .timer_scheduler_transaction(issuer, claim.namespace)
            .await?;
        if owner != claim.owner || issuer.tracker_scan_key() != claim.issuer_key {
            return Err(HistoryError::Unauthorized);
        }
        // Exact committed response first; never recreate a digest after Stop,
        // source change, disable or a lost HTTP result.
        if let Some(old)=sqlx::query("SELECT receipt_json,result_digest FROM tracker_scan_receipts WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(claim.conversation.to_string()).bind(claim.request_key())
            .fetch_optional(&mut *tx).await.map_err(unavailable)?{
            if old.get::<String,_>("result_digest")!=digest{return Err(HistoryError::Conflict);}
            let result=decode(&old)?;tx.commit().await.map_err(unavailable)?;return Ok(result);
        }
        let now = store_clock(&mut tx).await?;
        if now >= claim.deadline_ms {
            return Err(HistoryError::Conflict);
        }
        let current = view::current(&mut tx, &owner, claim.namespace, now).await?;
        if current.authority_id != claim.authority_id
            || current.conversation != claim.conversation
            || current.timer.generation != claim.generation
            || current.timer.next_due_ms != Some(claim.due_ms)
            || current.source_revision != claim.source_revision
            || current.source != claim.source
            || current.recipe_id != claim.recipe_id
            || current.classifier_id != claim.classifier_id
            || current.classifier_digest != claim.classifier_digest
            || current.stop_sequence != claim.stop_sequence
        {
            return Err(HistoryError::Conflict);
        }
        let stored=sqlx::query("SELECT state,attempt,deadline_ms,issuer_key FROM tracker_scan_attempts WHERE id=? AND owner_id=? AND conversation_id=?")
            .bind(claim.id.to_string()).bind(owner.to_string()).bind(claim.conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or(HistoryError::Conflict)?;
        if stored.get::<String, _>("state") != "reading"
            || stored.get::<i64, _>("attempt") != claim.attempt
            || stored.get::<i64, _>("deadline_ms") != claim.deadline_ms
            || stored.get::<String, _>("issuer_key") != claim.issuer_key
        {
            return Err(HistoryError::Conflict);
        }
        let record = scan::record_in_transaction(
            &mut tx,
            &owner,
            &claim.conversation,
            claim.source_revision,
            messages,
            cursor_json,
            summary_json,
        )
        .await
        .map_err(resource)?;
        let canonical = super::super::claim::scan_in_transaction(
            &mut tx,
            &owner,
            &TimerClaimRequest {
                namespace: claim.namespace,
                generation: claim.generation,
                due_ms: claim.due_ms,
                request_key: claim.request_key(),
            },
            now,
        )
        .await?;
        let news = record.changes.iter().any(|c| c.is_news());
        let result = TrackerScanReceipt {
            id: Uuid::new_v4(),
            request_key: claim.request_key(),
            namespace: claim.namespace,
            generation: claim.generation,
            due_ms: claim.due_ms,
            source_revision: claim.source_revision,
            recipe_id: claim.recipe_id.clone(),
            classifier_digest: claim.classifier_digest.clone(),
            news,
            digest_id: news.then(Uuid::new_v4),
            labelled: record.labelled,
            dropped: record.dropped,
            duplicates: record.duplicates,
            changes: record.changes,
            recorded_ms: now,
            duplicate: false,
        };
        let json = serde_json::to_string(&result).map_err(unavailable)?;
        sqlx::query("INSERT INTO tracker_scan_receipts(id,owner_id,namespace,generation,conversation_id,due_ms,attempt_id,claim_id,request_key,result_digest,receipt_json,recorded_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(result.id.to_string()).bind(owner.to_string()).bind(claim.namespace.to_string()).bind(claim.generation)
            .bind(claim.conversation.to_string()).bind(claim.due_ms).bind(claim.id.to_string()).bind(canonical.claim_id.to_string())
            .bind(&result.request_key).bind(digest).bind(json).bind(now).execute(&mut *tx).await.map_err(unavailable)?;
        if let Some(id) = result.digest_id {
            sqlx::query("INSERT INTO tracker_action_digests(id,action_id,owner_id,conversation_id,created_ms) VALUES(?,?,?,?,?)")
                .bind(id.to_string()).bind(result.id.to_string()).bind(owner.to_string()).bind(claim.conversation.to_string()).bind(now)
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        sqlx::query("UPDATE tracker_scan_attempts SET state='committed' WHERE id=? AND owner_id=? AND conversation_id=? AND state='reading'")
            .bind(claim.id.to_string()).bind(owner.to_string()).bind(claim.conversation.to_string()).execute(&mut *tx).await.map_err(unavailable)?;
        if store_clock(&mut tx).await? >= claim.deadline_ms {
            return Err(HistoryError::Conflict);
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    pub async fn tracker_scan_receipt(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        key: &str,
    ) -> Result<TrackerScanReceipt> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        let row=sqlx::query("SELECT receipt_json FROM tracker_scan_receipts WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(key)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or(HistoryError::NotFound)?;
        let result = decode(&row)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}
