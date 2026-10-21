//! Supervisor-side work for calendar timers: due digests and event triggers.
//! Same trust boundary as `timer_window`: only the authenticated supervisor
//! context can call these; browsers can only record events and read results.
use super::*;
use crate::history_import::{
    timers::{authority, digest, input::TimerInputReceipt, trigger},
    HistoryError,
};

impl Store {
    /// Create the digests that are due now (store clock). Returns how many had content.
    pub async fn generate_timer_digests(&self) -> crate::history_import::Result<u32> {
        let context = self.context().map_err(|_| HistoryError::Unauthorized)?;
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        context
            .validate(&mut tx)
            .await
            .map_err(|_| HistoryError::Unauthorized)?;
        let now = authority::store_clock(&mut tx).await?;
        let created = digest::generate_in_transaction(&mut tx, &context.owner, now).await?;
        tx.commit().await.map_err(|_| HistoryError::Unavailable)?;
        Ok(created)
    }

    /// Timers that have recorded trigger events waiting to run.
    pub async fn pending_timer_trigger_namespaces(
        &self,
        limit: u16,
    ) -> crate::history_import::Result<Vec<Uuid>> {
        if !(1..=32).contains(&limit) {
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
        let result = trigger::pending_in(&mut tx, &context.owner, limit).await?;
        tx.commit().await.map_err(|_| HistoryError::Unavailable)?;
        Ok(result)
    }

    /// Admit the run for a timer's pending trigger events, queueing the Deep
    /// window intent in the same transaction like a clock occurrence.
    pub async fn admit_authorized_trigger_turn(
        &self,
        issuer: &crate::TimerSchedulerIssuer,
        namespace: Uuid,
        queue_window: bool,
    ) -> crate::history_import::Result<Option<TimerInputReceipt>> {
        let (mut tx, owner) = self.timer_scheduler_transaction(issuer, namespace).await?;
        let now_ms = authority::store_clock(&mut tx).await?;
        let result =
            trigger::admit_pending_in_transaction(&mut tx, &owner, namespace, now_ms).await?;
        if let (Some(admitted), true) = (&result, queue_window) {
            execution_window::enqueue_timer_intent(
                &mut tx,
                &owner,
                &admitted.claim.conversation_id,
                admitted.input.message_id.clone(),
                admitted.input.event_id.clone(),
                &format!("timer:{}", admitted.claim.claim_id),
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
#[path = "timer_schedule_tests.rs"]
mod tests;
