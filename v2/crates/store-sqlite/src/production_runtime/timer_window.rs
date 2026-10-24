//! Timer occurrences that become Deep turns: admission of the due ordinary input
//! and, when a window dispatcher runs, its durable window intent commit together.
use super::*;
use crate::history_import::{
    timers::{authority, input::TimerInputReceipt},
    HistoryError,
};

impl Store {
    /// Metadata-only discovery of enabled granted timers that are due now by the
    /// Store clock. Not-yet-due timers are not scanned, so a failure on a due
    /// timer is a real hold, never ordinary waiting.
    pub async fn due_timer_scheduler_candidates(
        &self,
        after: Option<Uuid>,
        limit: u16,
    ) -> crate::history_import::Result<Vec<Uuid>> {
        if !(1..=32).contains(&limit) || after.is_some_and(|id| id.is_nil()) {
            return Err(HistoryError::Invalid);
        }
        let context = self.context().map_err(|_| HistoryError::Unauthorized)?;
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        context
            .validate(&mut tx)
            .await
            .map_err(|_| HistoryError::Unauthorized)?;
        let now = authority::store_clock(&mut tx).await?;
        let namespaces: Vec<String> = sqlx::query_scalar(
            "SELECT t.namespace FROM dormant_timers t WHERE t.owner_id=? AND (EXISTS(SELECT 1 FROM durable_timer_authorities a WHERE a.owner_id=t.owner_id AND a.namespace=t.namespace AND a.generation=t.generation) OR EXISTS(SELECT 1 FROM tracker_scan_authorities a WHERE a.owner_id=t.owner_id AND a.namespace=t.namespace AND a.generation=t.generation)) AND t.state='enabled' AND t.next_due_ms<=? AND t.namespace>? AND NOT EXISTS(SELECT 1 FROM timer_policies p WHERE p.owner_id=t.owner_id AND p.namespace=t.namespace AND p.pause_until_ms>?) AND NOT EXISTS(SELECT 1 FROM conversation_timer_pauses c WHERE c.owner_id=t.owner_id AND c.conversation_id=t.conversation_id AND c.pause_until_ms>?) ORDER BY t.namespace LIMIT ?",
        )
        .bind(context.owner.to_string())
        .bind(now)
        .bind(after.map(|id| id.to_string()).unwrap_or_default())
        .bind(now)
        .bind(now)
        .bind(i64::from(limit))
        .fetch_all(&mut *tx)
        .await
        .map_err(|_| HistoryError::Unavailable)?;
        let result = namespaces
            .into_iter()
            .map(|id| Uuid::parse_str(&id).map_err(|_| HistoryError::Unavailable))
            .collect();
        tx.commit().await.map_err(|_| HistoryError::Unavailable)?;
        result
    }

    /// Trusted local supervisor only. Admits the due occurrence like
    /// `admit_authorized_timer`; with `queue_window` it also records the Deep
    /// window intent in the same transaction, so an occurrence is either fully
    /// scheduled for execution or not admitted at all and retried later.
    pub async fn admit_authorized_timer_turn(
        &self,
        issuer: &crate::TimerSchedulerIssuer,
        namespace: Uuid,
        queue_window: bool,
    ) -> crate::history_import::Result<TimerInputReceipt> {
        let (mut tx, owner) = self.timer_scheduler_transaction(issuer, namespace).await?;
        let now_ms = authority::store_clock(&mut tx).await?;
        let result = authority::admit_in_transaction(&mut tx, &owner, namespace, now_ms).await?;
        if queue_window && !result.duplicate {
            execution_window::enqueue_timer_intent(
                &mut tx,
                &owner,
                &result.claim.conversation_id,
                result.input.message_id.clone(),
                result.input.event_id.clone(),
                &format!("timer:{}", result.claim.claim_id),
            )
            .await
            .map_err(|error| match error {
                RuntimeStoreError::Unavailable => HistoryError::Unavailable,
                _ => HistoryError::Conflict,
            })?;
        }
        tx.commit().await.map_err(|_| HistoryError::Unavailable)?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "timer_window_tests.rs"]
mod tests;
