//! A local refresh schedule never grants inference or extends the user's budget.
use orkestr_runtime::{containment::Authority, execution::CodexPump};
use orkestr_v2_store_sqlite::{ConsumedProviderDispatch, RunRenewalAuthority, Store};
use std::time::{Duration, Instant};

const REFRESH_INTERVAL: Duration = Duration::from_secs(20);

pub(super) struct RunningLease {
    authority: RunRenewalAuthority,
    next_refresh: Instant,
}

impl RunningLease {
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
        Ok(Self {
            authority,
            next_refresh: Instant::now() + REFRESH_INTERVAL,
        })
    }

    pub(super) fn due(&self, now: Instant) -> bool {
        now >= self.next_refresh
    }

    /// Caller owns the per-run scheduling lock and has checked current Running
    /// status plus Runtime quiescence. A failed consuming transfer remains
    /// uncertain and owns cleanup; the same grant is never submitted again.
    pub(super) async fn refresh(
        &mut self,
        store: Store,
        pump: CodexPump,
    ) -> Result<(Authority, CodexPump), &'static str> {
        let result = pump
            .renew_lease(store, &mut self.authority)
            .await
            .map_err(|_| "execution liveness transfer refused; reconciliation required")?;
        self.next_refresh = Instant::now() + REFRESH_INTERVAL;
        Ok(result)
    }
}
