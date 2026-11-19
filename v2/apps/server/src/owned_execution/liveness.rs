//! A local refresh schedule never grants inference or extends the user's budget.
use orkestr_runtime::{containment::Authority, execution::CodexPump};
use orkestr_v2_store_sqlite::{
    CodexSteeringAuthority, ConsumedProviderDispatch, RunRenewalAuthority, Store,
};
use std::time::{Duration, Instant};

const REFRESH_INTERVAL: Duration = Duration::from_secs(20);

/// Refresh on the usual interval, but early enough that the lease still keeps
/// the margin when the refresh falls due (as Worker leases schedule theirs).
/// An unreadable clock refreshes at once.
fn refresh_after(lease_deadline_ms: i64, wall_now_ms: Option<i64>) -> Duration {
    let Some(wall) = wall_now_ms else {
        return Duration::ZERO;
    };
    let remaining =
        Duration::from_millis(u64::try_from(lease_deadline_ms.saturating_sub(wall)).unwrap_or(0));
    REFRESH_INTERVAL.min(remaining.saturating_sub(super::supervisor_lease::LEASE_MARGIN))
}

pub(super) struct RunningLease {
    authority: RunRenewalAuthority,
    next_refresh: Instant,
}

impl RunningLease {
    pub(super) fn authority(&self) -> &RunRenewalAuthority {
        &self.authority
    }
    /// Capture the opaque authority before the exact consumed grant is moved
    /// into Runtime. Neither a run locator nor an HTTP field can replace it.
    pub(super) async fn capture(
        store: &Store,
        capability: &ConsumedProviderDispatch,
    ) -> Result<Self, &'static str> {
        let authority = store
            .authorize_running_renewal(capability)
            .await
            .map_err(|_| "execution liveness authority refused")?;
        let mut lease = Self {
            authority,
            next_refresh: Instant::now(),
        };
        lease.schedule();
        Ok(lease)
    }

    fn schedule(&mut self) {
        self.next_refresh = Instant::now()
            + refresh_after(
                self.authority.lease_deadline_ms(),
                super::supervisor_lease::wall_now_ms(),
            );
    }

    pub(super) fn due(&self, now: Instant) -> bool {
        now >= self.next_refresh
    }

    /// The run's current lease deadline (Core clock, ms): scheduling only.
    pub(super) fn lease_deadline_ms(&self) -> i64 {
        self.authority.lease_deadline_ms()
    }

    /// Caller owns the per-run scheduling lock and has checked current Running
    /// status plus Runtime quiescence. A failed consuming transfer remains
    /// uncertain and owns cleanup; the same grant is never submitted again.
    pub(super) async fn refresh(
        &mut self,
        store: Store,
        pump: CodexPump,
        steering: CodexSteeringAuthority,
    ) -> Result<(Authority, CodexPump, CodexSteeringAuthority), &'static str> {
        let result = pump
            .renew_lease_with_steering(store, &mut self.authority, steering)
            .await
            .map_err(|_| "execution liveness transfer refused; reconciliation required")?;
        self.schedule();
        Ok(result)
    }

    /// A run without steering (a read-only parallel Deep slot): the same
    /// same-child lease transfer, no issuer refresh.
    pub(super) async fn refresh_plain(
        &mut self,
        store: Store,
        pump: CodexPump,
    ) -> Result<(Authority, CodexPump), &'static str> {
        let result = pump
            .renew_lease(store, &mut self.authority)
            .await
            .map_err(|_| "execution liveness transfer refused; reconciliation required")?;
        self.schedule();
        Ok(result)
    }

    /// Claude counterpart: the same native child, turn and cursor continue.
    pub(super) async fn refresh_claude(
        &mut self,
        live: &mut crate::claude_execution::LiveClaudeExecution,
    ) -> Result<(), &'static str> {
        live.renew(&mut self.authority)
            .await
            .map_err(|_| "Claude liveness transfer refused; reconciliation required")?;
        self.schedule();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_keeps_the_margin_on_a_short_lease() {
        let margin = super::super::supervisor_lease::LEASE_MARGIN;
        let wall = 1_000_000;
        // A full lease refreshes on the usual interval.
        assert_eq!(refresh_after(wall + 60_000, Some(wall)), REFRESH_INTERVAL);
        // A short lease refreshes while the margin is still left.
        let short = wall + i64::try_from(margin.as_millis()).unwrap() + 5_000;
        assert_eq!(refresh_after(short, Some(wall)), Duration::from_secs(5));
        // Down to the margin, past it, or no clock: refresh now.
        assert_eq!(refresh_after(wall + 10_000, Some(wall)), Duration::ZERO);
        assert_eq!(refresh_after(wall - 1, Some(wall)), Duration::ZERO);
        assert_eq!(refresh_after(wall + 60_000, None), Duration::ZERO);
    }
}
