//! A read attempt never claims/advances the ordinary timer occurrence.
use super::*;
const LEASE_MS: i64 = 10_000;

impl Store {
    /// Trusted scheduler only. The caller first reserves a bounded reader slot,
    /// and retains it until the actual I/O returns, even if this lease expires.
    pub async fn claim_tracker_scan(
        &self,
        issuer: &crate::TimerSchedulerIssuer,
        namespace: Uuid,
    ) -> Result<TrackerScanClaim> {
        let (mut tx, owner) = self.timer_scheduler_transaction(issuer, namespace).await?;
        let now = store_clock(&mut tx).await?;
        let current = view::current(&mut tx, &owner, namespace, now).await?;
        // Expiry is a negative database fence, never evidence of joined I/O.
        // The in-process pool independently prevents a second live reader.
        sqlx::query("UPDATE tracker_scan_attempts SET state='expired' WHERE owner_id=? AND conversation_id=? AND state='reading' AND deadline_ms<=?")
            .bind(owner.to_string()).bind(current.conversation.to_string()).bind(now)
            .execute(&mut *tx).await.map_err(unavailable)?;
        let active:i64=sqlx::query_scalar("SELECT count(*) FROM tracker_scan_attempts WHERE owner_id=? AND conversation_id=? AND state='reading'")
            .bind(owner.to_string()).bind(current.conversation.to_string()).fetch_one(&mut *tx).await.map_err(unavailable)?;
        if active != 0 {
            return Err(HistoryError::Conflict);
        }
        let due = current.timer.next_due_ms.ok_or(HistoryError::Conflict)?;
        let prior:i64=sqlx::query_scalar("SELECT COALESCE(max(attempt),0) FROM tracker_scan_attempts WHERE owner_id=? AND namespace=? AND generation=? AND due_ms=?")
            .bind(owner.to_string()).bind(namespace.to_string()).bind(current.timer.generation).bind(due)
            .fetch_one(&mut *tx).await.map_err(unavailable)?;
        let attempt = prior.checked_add(1).ok_or(HistoryError::Conflict)?;
        let id = Uuid::new_v4();
        let deadline = now.checked_add(LEASE_MS).ok_or(HistoryError::Unavailable)?;
        let issuer_key = issuer.tracker_scan_key();
        sqlx::query("INSERT INTO tracker_scan_attempts(id,owner_id,namespace,generation,conversation_id,authority_id,due_ms,attempt,source_revision,classifier_digest,stop_sequence,deadline_ms,issuer_key,state,created_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'reading',?)")
            .bind(id.to_string()).bind(owner.to_string()).bind(namespace.to_string()).bind(current.timer.generation)
            .bind(current.conversation.to_string()).bind(current.authority_id.to_string()).bind(due).bind(attempt)
            .bind(current.source_revision).bind(&current.classifier_digest).bind(current.stop_sequence).bind(deadline).bind(&issuer_key).bind(now)
            .execute(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(TrackerScanClaim {
            read_policy_id: current.read_policy_id,
            id,
            owner,
            namespace,
            generation: current.timer.generation,
            conversation: current.conversation,
            authority_id: current.authority_id,
            due_ms: due,
            attempt,
            source_revision: current.source_revision,
            source: current.source,
            recipe_id: current.recipe_id,
            classifier_id: current.classifier_id,
            classifier_digest: current.classifier_digest,
            stop_sequence: current.stop_sequence,
            deadline_ms: deadline,
            issuer_key,
        })
    }

    /// Reader failure releases no occurrence and advances no schedule. The
    /// server still retains actual reader custody independently of this mark.
    pub async fn abandon_tracker_scan(
        &self,
        issuer: &crate::TimerSchedulerIssuer,
        claim: &TrackerScanClaim,
    ) -> Result<()> {
        let (mut tx, owner) = self
            .timer_scheduler_transaction(issuer, claim.namespace)
            .await?;
        if owner != claim.owner || issuer.tracker_scan_key() != claim.issuer_key {
            return Err(HistoryError::Unauthorized);
        }
        sqlx::query("UPDATE tracker_scan_attempts SET state='failed' WHERE id=? AND owner_id=? AND conversation_id=? AND issuer_key=? AND state='reading'")
            .bind(claim.id.to_string()).bind(owner.to_string()).bind(claim.conversation.to_string()).bind(&claim.issuer_key)
            .execute(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(())
    }
}
