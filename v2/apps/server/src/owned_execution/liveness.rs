//! A local refresh schedule never grants inference or extends the user's budget.
//!
//! A renewal that Core refused before writing anything (`RenewalRefusal::Retry`:
//! the Root workspace check did not answer in time, the writer was busy, the
//! supervisor deadline did not allow an extension yet) keeps the same child on
//! its current lease. It is retried with backoff while that lease keeps the
//! same margin as the supervisor heartbeat (`supervisor_lease::LEASE_MARGIN`);
//! only authority loss, an uncertain commit, or a lease that would really lapse
//! quarantines the child.
use super::supervisor_lease::{retry_delay, wall_now_ms, LEASE_MARGIN};
use orkestr_runtime::{
    containment::Authority,
    execution::{CodexPump, QuarantineOwned, RenewalRefusal},
};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_store_sqlite::{
    CodexSteeringAuthority, ConsumedProviderDispatch, RunRenewalAuthority, Store,
};
use std::time::{Duration, Instant};

const REFRESH_INTERVAL: Duration = Duration::from_secs(20);
const REFUSED: &str = "execution liveness transfer refused; reconciliation required";

/// Refresh on the usual interval, but early enough that the lease still keeps
/// the margin when the refresh falls due (as Worker leases schedule theirs).
/// An unreadable clock refreshes at once.
fn refresh_after(lease_deadline_ms: i64, wall_now_ms: Option<i64>) -> Duration {
    let Some(wall) = wall_now_ms else {
        return Duration::ZERO;
    };
    REFRESH_INTERVAL.min(remaining(lease_deadline_ms, wall).saturating_sub(LEASE_MARGIN))
}

fn remaining(lease_deadline_ms: i64, wall_now_ms: i64) -> Duration {
    Duration::from_millis(u64::try_from(lease_deadline_ms.saturating_sub(wall_now_ms)).unwrap_or(0))
}

/// A refused renewal's retry, or None when the lease no longer keeps the
/// margin (or the clock cannot be read): then the caller gives up.
pub(super) fn retry_after(
    lease_deadline_ms: i64,
    wall_now_ms: Option<i64>,
    failures: u32,
) -> Option<Duration> {
    let spare = remaining(lease_deadline_ms, wall_now_ms?)
        .checked_sub(LEASE_MARGIN)
        .filter(|spare| !spare.is_zero())?;
    Some(retry_delay(failures).min(spare))
}

/// A renewal attempt that did not pause the run.
pub(super) enum Renewal<R, K> {
    /// The lease transferred; the new owner(s).
    Renewed(R),
    /// Core wrote nothing; the same owner(s) keep the current lease.
    Kept(K),
}

pub(super) struct RunningLease {
    authority: RunRenewalAuthority,
    next_refresh: Instant,
    failures: u32,
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
            failures: 0,
        };
        lease.schedule();
        Ok(lease)
    }

    fn schedule(&mut self) {
        self.failures = 0;
        self.next_refresh =
            Instant::now() + refresh_after(self.authority.lease_deadline_ms(), wall_now_ms());
    }

    pub(super) fn due(&self, now: Instant) -> bool {
        now >= self.next_refresh
    }

    /// The run's current lease deadline (Core clock, ms): scheduling only.
    pub(super) fn lease_deadline_ms(&self) -> i64 {
        self.authority.lease_deadline_ms()
    }

    /// Keep a retained owner for another attempt while the lease keeps the
    /// margin; otherwise quarantine it as a lost renewal.
    fn keep<T: QuarantineOwned>(
        &mut self,
        refusal: RenewalRefusal<T>,
        role: &str,
    ) -> Result<T, &'static str> {
        let detail = self.authority.refusal_detail(refusal.error());
        match refusal {
            RenewalRefusal::Retry { retained, .. } => {
                let failures = self.failures.saturating_add(1);
                match retry_after(self.authority.lease_deadline_ms(), wall_now_ms(), failures) {
                    Some(delay) => {
                        self.failures = failures;
                        self.next_refresh = Instant::now() + delay;
                        eprintln!(
                            "owned {role} liveness transfer deferred: {detail} retry_ms={}",
                            delay.as_millis()
                        );
                        Ok(*retained)
                    }
                    None => {
                        eprintln!(
                            "owned {role} liveness transfer refused: {detail}; run lease would lapse"
                        );
                        retained.quarantine_owned();
                        Err(REFUSED)
                    }
                }
            }
            RenewalRefusal::Lost(_) => {
                eprintln!("owned {role} liveness transfer refused: {detail}");
                Err(REFUSED)
            }
        }
    }

    /// Caller owns the per-run scheduling lock and has checked current Running
    /// status plus Runtime quiescence. A failed consuming transfer remains
    /// uncertain and owns cleanup; the same grant is never submitted again.
    pub(super) async fn refresh(
        &mut self,
        store: Store,
        pump: CodexPump,
        steering: CodexSteeringAuthority,
    ) -> Result<
        Renewal<
            (Authority, CodexPump, CodexSteeringAuthority),
            (CodexPump, CodexSteeringAuthority),
        >,
        &'static str,
    > {
        match pump
            .renew_lease_with_steering(store, &mut self.authority, steering)
            .await
        {
            Ok(renewed) => {
                self.schedule();
                Ok(Renewal::Renewed(renewed))
            }
            Err(refusal) => self.keep(refusal, "execution").map(Renewal::Kept),
        }
    }

    /// A run without steering (a read-only parallel Deep slot): the same
    /// same-child lease transfer, no issuer refresh.
    pub(super) async fn refresh_plain(
        &mut self,
        store: Store,
        pump: CodexPump,
    ) -> Result<Renewal<(Authority, CodexPump), CodexPump>, &'static str> {
        match pump.renew_lease(store, &mut self.authority).await {
            Ok(renewed) => {
                self.schedule();
                Ok(Renewal::Renewed(renewed))
            }
            Err(refusal) => self.keep(refusal, "parallel Deep").map(Renewal::Kept),
        }
    }

    /// Claude counterpart: the same native child, turn and cursor continue.
    /// `Ok(false)`: Core wrote nothing and the same child keeps its lease.
    pub(super) async fn refresh_claude(
        &mut self,
        live: &mut crate::claude_execution::LiveClaudeExecution,
    ) -> Result<bool, &'static str> {
        match live.renew(&mut self.authority).await {
            Ok(true) => {
                self.schedule();
                Ok(true)
            }
            Ok(false) => {
                let detail = self.authority.refusal_detail(RuntimeStoreError::Busy);
                let failures = self.failures.saturating_add(1);
                match retry_after(self.authority.lease_deadline_ms(), wall_now_ms(), failures) {
                    Some(delay) => {
                        self.failures = failures;
                        self.next_refresh = Instant::now() + delay;
                        eprintln!(
                            "owned Claude liveness transfer deferred: {detail} retry_ms={}",
                            delay.as_millis()
                        );
                        Ok(false)
                    }
                    None => {
                        eprintln!(
                            "owned Claude liveness transfer refused: {detail}; run lease would lapse"
                        );
                        live.abandon_renewal();
                        Err("Claude liveness transfer refused; reconciliation required")
                    }
                }
            }
            Err(error) => {
                eprintln!(
                    "owned Claude liveness transfer refused: {}",
                    self.authority.refusal_detail(error)
                );
                Err("Claude liveness transfer refused; reconciliation required")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_keeps_the_margin_on_a_short_lease() {
        let wall = 1_000_000;
        // A full lease refreshes on the usual interval.
        assert_eq!(refresh_after(wall + 60_000, Some(wall)), REFRESH_INTERVAL);
        // A short lease refreshes while the margin is still left.
        let short = wall + i64::try_from(LEASE_MARGIN.as_millis()).unwrap() + 5_000;
        assert_eq!(refresh_after(short, Some(wall)), Duration::from_secs(5));
        // Down to the margin, past it, or no clock: refresh now.
        assert_eq!(refresh_after(wall + 10_000, Some(wall)), Duration::ZERO);
        assert_eq!(refresh_after(wall - 1, Some(wall)), Duration::ZERO);
        assert_eq!(refresh_after(wall + 60_000, None), Duration::ZERO);
    }

    #[test]
    fn a_kept_renewal_retries_with_backoff_and_gives_up_at_the_margin() {
        let wall = 1_000_000;
        let margin = i64::try_from(LEASE_MARGIN.as_millis()).unwrap();
        // 40 s left at the usual refresh: retries 0.5 s, 1 s, 2 s, then 4 s.
        let due = wall + 40_000;
        assert_eq!(
            retry_after(due, Some(wall), 1),
            Some(Duration::from_millis(500))
        );
        assert_eq!(
            retry_after(due, Some(wall), 3),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            retry_after(due, Some(wall), 9),
            Some(Duration::from_secs(4))
        );
        // Never past the margin.
        assert_eq!(
            retry_after(wall + margin + 1_500, Some(wall), 9),
            Some(Duration::from_millis(1_500))
        );
        // At the margin, past it, or no clock: give up.
        assert_eq!(retry_after(wall + margin, Some(wall), 1), None);
        assert_eq!(retry_after(wall - 1, Some(wall), 1), None);
        assert_eq!(retry_after(due, None, 1), None);
    }
}
