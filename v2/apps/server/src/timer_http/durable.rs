//! Restart-safe controller leaf. Deep owns supervisor bootstrap and joined lifecycle.
//! No browser credentials, instruction cache, caller clock or HTTP dispatch port.
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_store_sqlite::{history_import::HistoryError, Store};
use std::time::Duration;
use uuid::Uuid;
const PAGE: u16 = 32;

#[derive(Default, Debug, PartialEq, Eq)]
pub struct DurableTick {
    pub scanned: u32,
    pub admitted: u32,
    /// Not due or concurrently disabled/stopped; no authority is recreated.
    pub deferred: u32,
}
/// Own exactly one per authenticated supervisor lifecycle. Not a cloned task pool.
pub struct DurableTimerController {
    supervisor: Store,
    after: Option<Uuid>,
}
impl DurableTimerController {
    /// A normal/worker Store cannot pass Core's subsequent context validation.
    pub fn new(supervisor: Store) -> Self {
        Self {
            supervisor,
            after: None,
        }
    }
    /// One bounded page; cursor is process-local fairness metadata, never authority.
    pub async fn tick(&mut self) -> Result<DurableTick, HistoryError> {
        tokio::time::timeout(Duration::from_secs(5), self.pass())
            .await
            .map_err(|_| HistoryError::Unavailable)?
    }
    async fn pass(&mut self) -> Result<DurableTick, HistoryError> {
        let candidates = self
            .supervisor
            .timer_scheduler_candidates(self.after, PAGE)
            .await?;
        let next = next_cursor(&candidates);
        let mut result = DurableTick::default();
        for namespace in candidates {
            // Fresh issuer every time: discovery/UUID alone never grants admission.
            let issuer = self
                .supervisor
                .authorize_timer_scheduler(namespace)
                .await
                .map_err(|error| match error {
                    RuntimeStoreError::Unavailable => HistoryError::Unavailable,
                    _ => HistoryError::Unauthorized,
                })?;
            result.scanned += 1;
            match self
                .supervisor
                .admit_authorized_timer(&issuer, namespace)
                .await
            {
                Ok(receipt) => {
                    if !receipt.duplicate {
                        result.admitted += 1;
                    }
                }
                Err(HistoryError::Conflict | HistoryError::NotFound) => result.deferred += 1,
                Err(error) => return Err(error),
            }
            // Issuer drops here; no instruction or credential is retained locally.
        }
        self.after = next;
        Ok(result)
    }
    /// No runtime registration here. Caller must join this future on shutdown.
    /// Auth/context failure terminates; trusted bootstrap must provide a fresh context.
    pub async fn run(
        mut self,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), HistoryError> {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            if *shutdown.borrow() {
                return Ok(());
            }
            tokio::select! {
                changed=shutdown.changed()=>{if changed.is_err() || *shutdown.borrow(){return Ok(());}},
                _=interval.tick()=>{self.tick().await?;}
            }
        }
    }
}
fn next_cursor(page: &[Uuid]) -> Option<Uuid> {
    if page.len() == usize::from(PAGE) {
        page.last().copied()
    } else {
        None
    }
}
#[cfg(test)]
#[path = "durable_tests.rs"]
mod tests;
