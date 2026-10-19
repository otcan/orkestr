//! Local scheduling against the original Core deadlines, not a new budget.
use orkestr_v2_contracts::{ExecutionWindowLimits, ExecutionWindowState, ExecutionWindowStatus};
use std::time::{Duration, Instant};

pub(super) struct Clock {
    work: Instant,
    cleanup: Instant,
}

impl Clock {
    /// Construct once after the matching manager ACK. Existing active or
    /// retiring windows cannot be reconstructed with a fresh local clock.
    pub(super) fn opening(
        status: &ExecutionWindowStatus,
        wall_ms: i64,
        monotonic: Instant,
    ) -> Result<Self, &'static str> {
        if status.state != ExecutionWindowState::Opening
            || status.window_id.is_nil()
            || status.conversation_id.0.is_nil()
            || status.generation == 0
            || status.limits != ExecutionWindowLimits::default()
            || status.opened_at_ms.checked_add(870_000) != Some(status.work_deadline_ms)
            || status.opened_at_ms.checked_add(900_000) != Some(status.expires_at_ms)
            || wall_ms < status.opened_at_ms
            || wall_ms >= status.work_deadline_ms
        {
            return Err("window original deadline invalid or elapsed");
        }
        let work = Duration::from_millis((status.work_deadline_ms - wall_ms) as u64);
        let cleanup = Duration::from_millis((status.expires_at_ms - wall_ms) as u64);
        Ok(Self {
            work: monotonic.checked_add(work).ok_or("window clock overflow")?,
            cleanup: monotonic
                .checked_add(cleanup)
                .ok_or("window clock overflow")?,
        })
    }

    pub(super) fn work_due(&self, now: Instant) -> bool {
        now >= self.work
    }

    pub(super) fn cleanup_deadline(&self) -> tokio::time::Instant {
        self.cleanup.into()
    }
}

#[cfg(test)]
#[path = "clock_tests.rs"]
mod tests;
