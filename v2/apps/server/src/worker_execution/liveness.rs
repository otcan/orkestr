//! Same-child Worker renewal under explicit owner and private host budgets.
use orkestr_runtime::{containment::Authority, execution::CodexPump};
use orkestr_v2_store_sqlite::{ConsumedProviderDispatch, RunRenewalAuthority, Store};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const REFRESH_INTERVAL: Duration = Duration::from_secs(10);
const STOP_MARGIN_MS: u64 = 250;

pub(super) struct WorkerLease {
    authority: RunRenewalAuthority,
    hard_deadline_ms: i64,
    lease_deadline_ms: i64,
    next_refresh: Instant,
    stop_at: Instant,
}

impl WorkerLease {
    pub(super) async fn capture(
        store: &Store,
        capability: &ConsumedProviderDispatch,
        host_max_run_ms: u32,
    ) -> Result<Self, &'static str> {
        let authority = store
            .authorize_worker_running_renewal(capability, host_max_run_ms)
            .await
            .map_err(|_| "Worker bounded renewal authority refused")?;
        let hard_deadline_ms = authority
            .hard_deadline_ms()
            .ok_or("Worker immutable budget missing")?;
        let now = Instant::now();
        let mut result = Self {
            authority,
            hard_deadline_ms,
            lease_deadline_ms: capability.provider().run.lease_deadline_ms,
            next_refresh: now,
            stop_at: now,
        };
        result.schedule(now)?;
        Ok(result)
    }

    pub(super) fn authority(&self) -> &RunRenewalAuthority {
        &self.authority
    }

    pub(super) fn due(&self, now: Instant) -> bool {
        // A final lease already reaches the immutable budget. Attempting to
        // renew it would correctly refuse and consume the owned transport.
        self.lease_deadline_ms < self.hard_deadline_ms && now >= self.next_refresh
    }

    pub(super) fn must_stop(&self, now: Instant) -> bool {
        now >= self.stop_at
    }

    pub(super) async fn refresh(
        &mut self,
        store: Store,
        pump: CodexPump,
    ) -> Result<(Authority, CodexPump), &'static str> {
        let (authority, pump) = pump
            .renew_lease(store, &mut self.authority)
            .await
            .map_err(|_| "Worker renewal transfer requires reconciliation")?;
        self.lease_deadline_ms = pump.lease_deadline_ms();
        self.schedule(Instant::now())?;
        Ok((authority, pump))
    }

    fn schedule(&mut self, now: Instant) -> Result<(), &'static str> {
        let epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
            .ok_or("Worker scheduling clock unavailable")?;
        let (refresh, stop) = window(self.lease_deadline_ms.min(self.hard_deadline_ms), epoch_ms);
        self.next_refresh = now + refresh;
        self.stop_at = now + stop;
        Ok(())
    }
}

// These are cancellation/refresh scheduling hints. Every effect still uses the
// current Store clock and exact sealed authority, including after clock drift.
fn window(deadline_ms: i64, clock_ms: i64) -> (Duration, Duration) {
    let remaining = u64::try_from(deadline_ms.saturating_sub(clock_ms))
        .unwrap_or(0)
        .min(30_000);
    (
        REFRESH_INTERVAL.min(Duration::from_millis(remaining.saturating_sub(1_000))),
        Duration::from_millis(remaining.saturating_sub(STOP_MARGIN_MS)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipped_or_expired_leases_never_create_a_new_local_allowance() {
        assert_eq!(
            window(30_000, 0),
            (Duration::from_secs(10), Duration::from_millis(29_750))
        );
        assert_eq!(window(700, 0), (Duration::ZERO, Duration::from_millis(450)));
        assert_eq!(window(0, 1), (Duration::ZERO, Duration::ZERO));
        assert_eq!(window(i64::MIN, i64::MAX), (Duration::ZERO, Duration::ZERO));
    }
}
