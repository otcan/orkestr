//! Spacing of automatic reconcile attempts the manager refused.
//!
//! The manager that holds a window refuses its reconciliation while its
//! cleanup is uncertain (`owned_cleanup_uncertain`) or a child is not reaped.
//! Every status poll, dispatcher pass and admission runs the automatic
//! reconcile paths, and each attempt holds the global `opening` lock for
//! several Core and manager calls. Without spacing they retried one such
//! window 798 times in ten minutes on 2026-11-10 (ORK-781).
//!
//! After a manager refusal, automatic attempts of that exact window wait 1 s,
//! then 2, 4, 8 and 16 s, then 30 s between attempts. The first refusal logs one
//! `ALERT`; the first success after refusals logs one line. A window that
//! needs an operator (see the manager's operator release) is therefore retried
//! at most every 30 s once its custody is released. Owner decisions (the
//! explicit endpoint, a new owner message) never wait for this.
use orkestr_v2_contracts::ExecutionWindowStatus;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

pub(super) const RETRY_BASE: Duration = Duration::from_secs(1);
pub(super) const RETRY_MAX: Duration = Duration::from_secs(30);
/// Bounded: entries of windows closed by another path age out.
const MAX_TRACKED: usize = 1024;

#[derive(Debug, Clone, Copy)]
struct Refusal {
    attempts: u32,
    next: Instant,
    since: Instant,
}

#[derive(Default)]
pub(in crate::window_runtime) struct ReconcileBackoff {
    refused: Mutex<HashMap<(uuid::Uuid, u64), Refusal>>,
}

fn key(window: &ExecutionWindowStatus) -> (uuid::Uuid, u64) {
    (window.window_id, window.generation)
}

/// Spacing after `attempts` consecutive refusals.
pub(super) fn delay(attempts: u32) -> Duration {
    RETRY_BASE
        .saturating_mul(1 << attempts.saturating_sub(1).min(5))
        .min(RETRY_MAX)
}

impl ReconcileBackoff {
    /// Whether an automatic attempt on this window may run at `now`.
    pub(super) fn due(&self, window: &ExecutionWindowStatus, now: Instant) -> bool {
        let Ok(refused) = self.refused.lock() else {
            return true;
        };
        refused
            .get(&key(window))
            .is_none_or(|refusal| now >= refusal.next)
    }

    /// Record a manager refusal. Returns the operator alert for the first
    /// refusal of this window only.
    pub(super) fn refused(
        &self,
        window: &ExecutionWindowStatus,
        cause: &'static str,
        now: Instant,
    ) -> Option<String> {
        let mut refused = self.refused.lock().ok()?;
        if refused.len() >= MAX_TRACKED {
            refused.retain(|_, refusal| now.saturating_duration_since(refusal.next) < RETRY_MAX);
        }
        let refusal = refused.entry(key(window)).or_insert(Refusal {
            attempts: 0,
            next: now,
            since: now,
        });
        refusal.attempts = refusal.attempts.saturating_add(1);
        let wait = delay(refusal.attempts);
        refusal.next = now.checked_add(wait).unwrap_or(now);
        (refusal.attempts == 1).then(|| {
            format!(
                "ALERT orkestr-v2-server window_reconcile_backoff conversation={} window={} generation={} cause=\"{cause}\" retry_ms={} max_retry_ms={}",
                window.conversation_id,
                window.window_id,
                window.generation,
                wait.as_millis(),
                RETRY_MAX.as_millis(),
            )
        })
    }

    /// Forget the window after a successful attempt. Returns one line when
    /// earlier attempts had been refused.
    pub(super) fn settled(&self, window: &ExecutionWindowStatus, now: Instant) -> Option<String> {
        let refusal = self.refused.lock().ok()?.remove(&key(window))?;
        Some(format!(
            "orkestr-v2-server window_reconcile_backoff_cleared conversation={} window={} generation={} refused_attempts={} after_ms={}",
            window.conversation_id,
            window.window_id,
            window.generation,
            refusal.attempts,
            now.saturating_duration_since(refusal.since).as_millis(),
        ))
    }

    #[cfg(test)]
    pub(in crate::window_runtime) fn attempts(&self, window: &ExecutionWindowStatus) -> u32 {
        self.refused
            .lock()
            .unwrap()
            .get(&key(window))
            .map_or(0, |refusal| refusal.attempts)
    }

    /// Test only: make the next automatic attempt due now.
    #[cfg(test)]
    pub(in crate::window_runtime) fn make_due(&self, window: &ExecutionWindowStatus) {
        if let Some(refusal) = self.refused.lock().unwrap().get_mut(&key(window)) {
            refusal.next = Instant::now();
        }
    }
}

#[cfg(test)]
#[path = "stranded_backoff_tests.rs"]
mod tests;
