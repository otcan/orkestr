//! Local scheduling against the Core deadlines, not a new budget. The opener
//! may move them later only after Core and the manager both recorded it.
use orkestr_v2_contracts::{ExecutionWindowLimits, ExecutionWindowState, ExecutionWindowStatus};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(super) struct Clock {
    deadlines: Mutex<Deadlines>,
    opened_at_ms: i64,
}
#[derive(Clone, Copy)]
struct Deadlines {
    work: Instant,
    cleanup: Instant,
    work_deadline_ms: i64,
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
            deadlines: Mutex::new(Deadlines {
                work: monotonic.checked_add(work).ok_or("window clock overflow")?,
                cleanup: monotonic
                    .checked_add(cleanup)
                    .ok_or("window clock overflow")?,
                work_deadline_ms: status.work_deadline_ms,
            }),
            opened_at_ms: status.opened_at_ms,
        })
    }

    fn current(&self) -> Deadlines {
        *self
            .deadlines
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn work_due(&self, now: Instant) -> bool {
        now >= self.current().work
    }

    pub(super) fn cleanup_deadline(&self) -> tokio::time::Instant {
        self.current().cleanup.into()
    }

    pub(super) fn opened_at_ms(&self) -> i64 {
        self.opened_at_ms
    }

    pub(super) fn work_deadline_ms(&self) -> i64 {
        self.current().work_deadline_ms
    }

    /// Move both deadlines later by the exact amount Core and the manager
    /// recorded. Never earlier: a stale or smaller value is ignored.
    pub(super) fn extend_to(&self, work_deadline_ms: i64) -> Result<(), &'static str> {
        let mut current = self
            .deadlines
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if work_deadline_ms <= current.work_deadline_ms {
            return Ok(());
        }
        let delta = Duration::from_millis((work_deadline_ms - current.work_deadline_ms) as u64);
        current.work = current
            .work
            .checked_add(delta)
            .ok_or("window clock overflow")?;
        current.cleanup = current
            .cleanup
            .checked_add(delta)
            .ok_or("window clock overflow")?;
        current.work_deadline_ms = work_deadline_ms;
        Ok(())
    }
}

#[cfg(test)]
#[path = "clock_tests.rs"]
mod tests;
