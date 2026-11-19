//! The window's supervisor heartbeat under a bounded host-side time budget.
//! The rules and their reasons are in `supervisor_lease`.
use super::{
    admission::heartbeat_due,
    supervisor_lease::{transient, wall_now_ms, Renewal},
    *,
};
use orkestr_v2_application::runtime::RuntimeStoreError;
use std::time::Instant;

const REFUSED: &str = "execution supervisor heartbeat refused";

impl ConfiguredExecution {
    /// Keep this execution's supervisor lease. Every store call here is bounded
    /// by a timeout, and the proven lease is checked on every call, also while
    /// a deferred heartbeat waits for its retry.
    pub(super) async fn maintain(&self, heartbeat: &mut Instant) -> Result<(), &'static str> {
        // This preliminary session check is never the authority for a write
        // (every write and the heartbeat authenticate again). A pool too busy
        // to answer it in time is no refusal; the lease bound below still holds.
        match tokio::time::timeout(self.supervisor_lease.read_timeout(), self.current()).await {
            Ok(current) => current?,
            Err(_) => eprintln!("owned execution session check deferred: store did not answer"),
        }
        let now = Instant::now();
        let lapsing = self.supervisor_lease.within_margin(now);
        if lapsing || (heartbeat_due(*heartbeat, now) && !self.supervisor_lease.retry_pending(now))
        {
            self.renew_supervisor(heartbeat).await?;
        }
        if self.supervisor_lease.within_margin(Instant::now()) {
            eprintln!("owned execution heartbeat refused: supervisor lease would lapse");
            return Err(REFUSED);
        }
        Ok(())
    }

    /// One supervisor heartbeat under a timeout. Granted, or Deferred while the
    /// proven lease keeps its margin; Err on lost authority, on a lease that
    /// would lapse, or when no lease can be proven at all.
    pub(super) async fn renew_supervisor(
        &self,
        heartbeat: &mut Instant,
    ) -> Result<Renewal, &'static str> {
        let lease = &self.supervisor_lease;
        let started = Instant::now();
        let error = match tokio::time::timeout(
            lease.heartbeat_timeout(),
            self.store.heartbeat_supervisor(),
        )
        .await
        {
            Ok(Ok(deadline_ms)) => {
                lease.granted(started, deadline_ms);
                *heartbeat = Instant::now();
                return Ok(Renewal::Granted);
            }
            Ok(Err(error)) => error,
            // A heartbeat that commits after this point only lengthens Core's
            // lease beyond the bound proven here.
            Err(_) => RuntimeStoreError::Unavailable,
        };
        if !transient(&error) {
            eprintln!("owned execution heartbeat refused: {error:?}");
            return Err(REFUSED);
        }
        // Core's validated record bounds the lease too; the read takes no
        // write lock. If it cannot answer, the bound already proven decides.
        let read_started = Instant::now();
        match tokio::time::timeout(
            lease.read_timeout(),
            self.store.supervisor_lease_remaining_ms(),
        )
        .await
        {
            Ok(Ok(remaining_ms)) => lease.observed(read_started, remaining_ms),
            Ok(Err(read)) if !transient(&read) => {
                eprintln!("owned execution heartbeat refused: {error:?}; lease read {read:?}");
                return Err(REFUSED);
            }
            Ok(Err(_)) | Err(_) => {}
        }
        let now = Instant::now();
        let remaining_ms = lease.remaining(now).map(|left| left.as_millis());
        match lease.refused(now) {
            Some(retry) => {
                eprintln!(
                    "owned execution heartbeat deferred: {error:?} lease_remaining_ms={} retry_ms={}",
                    remaining_ms.unwrap_or_default(),
                    retry.as_millis()
                );
                Ok(Renewal::Deferred)
            }
            None => {
                eprintln!(
                    "owned execution heartbeat refused: {error:?}; supervisor lease would lapse (lease_remaining_ms={remaining_ms:?})"
                );
                Err(REFUSED)
            }
        }
    }

    /// Admission needs a lease Core accepted just now, so the admitted run
    /// starts with a full lease. Waits under the same lease checks; false on
    /// shutdown (the claim then lapses with its own lease and the input stays).
    pub(super) async fn accepted_heartbeat(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<bool, &'static str> {
        loop {
            if *shutdown.borrow() {
                return Ok(false);
            }
            let now = Instant::now();
            if (!self.supervisor_lease.retry_pending(now)
                || self.supervisor_lease.within_margin(now))
                && self.renew_supervisor(heartbeat).await? == Renewal::Granted
            {
                return Ok(true);
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                _ = shutdown.changed() => {},
            }
        }
    }

    /// Whether a due run-lease renewal goes ahead now. A renewal is a consuming
    /// transfer (refused, it quarantines the native child) and extends the run
    /// only up to the supervisor deadline. So: go when healthy and Core granted
    /// a supervisor deadline past the run's; otherwise heartbeat first (outside
    /// its backoff, or once both margins are reached); while still deferred,
    /// hold as long as the run's lease and the proven supervisor lease keep the
    /// margin, then go.
    pub(super) async fn run_renewal_ready(
        &self,
        run_deadline_ms: i64,
        heartbeat: &mut Instant,
    ) -> Result<bool, &'static str> {
        let lease = &self.supervisor_lease;
        if !lease.deferred() && lease.can_extend(run_deadline_ms) {
            return Ok(true);
        }
        let now = Instant::now();
        let holding = lease.hold_run_renewal(run_deadline_ms, wall_now_ms(), now);
        if (!holding || !lease.retry_pending(now))
            && self.renew_supervisor(heartbeat).await? == Renewal::Granted
        {
            return Ok(true);
        }
        Ok(!lease.hold_run_renewal(run_deadline_ms, wall_now_ms(), Instant::now()))
    }
}
