//! A local refresh schedule never grants inference or extends the user's budget.
use orkestr_runtime::{containment::Authority, execution::CodexPump};
use orkestr_v2_store_sqlite::{
    CodexSteeringAuthority, ConsumedProviderDispatch, RunRenewalAuthority, Store,
};
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
        steering: CodexSteeringAuthority,
    ) -> Result<(Authority, CodexPump, CodexSteeringAuthority), &'static str> {
        let result = pump
            .renew_lease_with_steering(store, &mut self.authority, steering)
            .await
            .map_err(|_| "execution liveness transfer refused; reconciliation required")?;
        self.next_refresh = Instant::now() + REFRESH_INTERVAL;
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
        self.next_refresh = Instant::now() + REFRESH_INTERVAL;
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
        self.next_refresh = Instant::now() + REFRESH_INTERVAL;
        Ok(())
    }
}
