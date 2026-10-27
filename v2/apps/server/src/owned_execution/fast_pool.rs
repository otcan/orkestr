//! Concurrent window Fast: every owner input gets its own presentation.
//!
//! The canonical lineage (slot 0) keeps its exact serial continuity rules.
//! While it is busy, each further admissible owner input of the window starts
//! in an auxiliary slot with its own fresh native session, scratch directory,
//! run lease, budget, control registration and original reap witness. Core
//! bounds live slots per conversation (schema-enforced); extra slots start
//! only while the host has headroom. Window close or shutdown starts nothing
//! new, and the pool returns only after every slot finished its own close.
use super::window_roles::Companion;
use super::*;
use orkestr_runtime::containment::ReapedBroker;
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_store_sqlite::{FastAdmissionInput, FastSource, MAX_AUXILIARY_FAST_SLOTS};
use std::future::Future;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Instant;

/// Very high host-wide backstop for auxiliary Fast across all windows. Live
/// host pressure, not this number, is the working limit.
const HOST_BACKSTOP: usize = 16;
static HOST_AUXILIARY: AtomicUsize = AtomicUsize::new(0);
const POLL: Duration = Duration::from_millis(100);

/// What the scheduler needs from its window; a seam for deterministic tests.
pub(super) trait SlotHost: Send + Sync + 'static {
    fn companion(&self) -> &Companion;
    /// Shutdown or window work deadline: start nothing new.
    fn closing(&self) -> bool;
    /// Live host pressure allows this window to start one more slot now.
    /// Consumes that allowance.
    fn admit_one(&self) -> bool;
    /// Take the current host reading (cheap while unchanged), so pressure
    /// averages are warm before a burst asks for a slot.
    fn observe(&self) {}
    fn next_source(&self) -> impl Future<Output = Result<Option<FastSource>, &'static str>> + Send;
    /// One complete auxiliary presentation; its witness if a child launched.
    fn present(
        self: Arc<Self>,
        source: FastSource,
    ) -> impl Future<Output = Result<SlotEnd, &'static str>> + Send;
}

/// How one auxiliary slot ended without failing the companion.
pub(super) enum SlotEnd {
    /// Admitted and closed; the original reap witness of its child.
    Presented(Option<ReapedBroker>),
    /// Never admitted (every slot live, or the window closed first): the
    /// input goes back to the lineage.
    Unstarted,
    /// Setup failed, or Core refused the admission itself, before any run
    /// existed: only this slot and its message lose Fast. Deep still answers
    /// the message; the lineage and the other slots keep running. The input
    /// stays claimed for this window so no task retries it into the failure.
    SetupFailed(&'static str),
}

struct HostSlot;
impl HostSlot {
    fn acquire() -> Option<Self> {
        HOST_AUXILIARY
            .try_update(Ordering::AcqRel, Ordering::Acquire, |live| {
                (live < HOST_BACKSTOP).then_some(live + 1)
            })
            .ok()
            .map(|_| Self)
    }
}
impl Drop for HostSlot {
    fn drop(&mut self) {
        HOST_AUXILIARY.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) async fn run(
    this: Arc<ConfiguredExecution>,
    grant: BoundSessionMetadata,
    shutdown: watch::Receiver<bool>,
) -> Result<(), &'static str> {
    let lineage = {
        let this = this.clone();
        let shutdown = shutdown.clone();
        async move { this.fast_lineage(grant, shutdown, Instant::now()).await }
    };
    let host = Arc::new(WindowSlots {
        execution: this,
        shutdown: shutdown.clone(),
        pressure: std::sync::Mutex::new(super::host_pressure::HostPressure::new()),
    });
    schedule(host, lineage, shutdown).await
}

/// Each task enters synchronous Core fences with `block_in_place`, so every
/// presentation is its own Tokio task (see `join_roles`). A slot that ends
/// before admission stays local to it. Any other task failure stops new
/// slots, but every other task (the lineage included) still runs to its own
/// exact close: aborting siblings mid-run would strand their runs and their
/// reap witnesses. The first failure is returned once all have finished, and
/// then fails the companion as one Fast failure did before.
pub(super) async fn schedule<H: SlotHost>(
    host: Arc<H>,
    lineage: impl Future<Output = Result<(), &'static str>> + Send + 'static,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), &'static str> {
    let mut tasks = tokio::task::JoinSet::new();
    let lineage = tasks.spawn(lineage).id();
    let mut lineage_done = false;
    let mut failure = None;
    'schedule: loop {
        while let Some(joined) = tasks.try_join_next_with_id() {
            match finished(joined) {
                Ok(id) => lineage_done |= id == lineage,
                Err(error) => {
                    failure = Some(error);
                    break 'schedule;
                }
            }
        }
        if lineage_done || host.closing() {
            break;
        }
        host.observe();
        // Start every input that is waiting now, up to the live bounds.
        loop {
            match start_slot(&host, &mut tasks).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => {
                    failure = Some(error);
                    break 'schedule;
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(POLL) => {},
            _ = shutdown.changed() => {},
        }
    }
    // Drain: every started presentation finishes its own exact close.
    while let Some(joined) = tasks.join_next_with_id().await {
        if let Err(error) = finished(joined) {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

fn finished(
    joined: Result<(tokio::task::Id, Result<(), &'static str>), tokio::task::JoinError>,
) -> Result<tokio::task::Id, &'static str> {
    match joined {
        Ok((id, Ok(()))) => Ok(id),
        Ok((_, Err(error))) => Err(error),
        Err(_) => Err("Fast slot task lost"),
    }
}

/// `true` when one more auxiliary presentation started.
async fn start_slot<H: SlotHost>(
    host: &Arc<H>,
    tasks: &mut tokio::task::JoinSet<Result<(), &'static str>>,
) -> Result<bool, &'static str> {
    let companion = host.companion();
    if !companion.wants_slot() || companion.active_slots() >= MAX_AUXILIARY_FAST_SLOTS.into() {
        return Ok(false);
    }
    let Some(source) = host.next_source().await? else {
        return Ok(false);
    };
    // More than one concurrent Fast only while the host has headroom.
    if !host.admit_one() {
        return Ok(false);
    }
    let Some(backstop) = HostSlot::acquire() else {
        return Ok(false);
    };
    if !companion.claim_source(&source.event_id) {
        return Ok(false);
    }
    if !companion.enter_slot() {
        companion.release_source(&source.event_id);
        return Ok(false);
    }
    let host = host.clone();
    tasks.spawn(async move {
        let _backstop = backstop;
        let event = source.event_id.clone();
        let result = host.clone().present(source).await;
        let companion = host.companion();
        match result {
            Ok(SlotEnd::Presented(proof)) => {
                // An admitted input stays claimed for the window's life, so
                // no reader that raced its admission can pick it again.
                companion.leave_slot(proof);
                Ok(())
            }
            Ok(SlotEnd::Unstarted) => {
                companion.release_source(&event);
                companion.leave_slot(None);
                Ok(())
            }
            Ok(SlotEnd::SetupFailed(reason)) => {
                // Static local diagnostic only; never provider text or IDs.
                eprintln!("owned window Fast slot setup failed: {reason}; Deep answers its input");
                companion.leave_slot(None);
                Ok(())
            }
            Err(error) => {
                companion.leave_slot(None);
                Err(error)
            }
        }
    });
    Ok(true)
}

struct WindowSlots {
    execution: Arc<ConfiguredExecution>,
    shutdown: watch::Receiver<bool>,
    pressure: std::sync::Mutex<super::host_pressure::HostPressure>,
}

impl SlotHost for WindowSlots {
    fn companion(&self) -> &Companion {
        self.execution
            .companion
            .as_deref()
            .expect("pooled Fast always has a companion")
    }
    fn closing(&self) -> bool {
        *self.shutdown.borrow() || self.execution.fast_window_due()
    }
    fn admit_one(&self) -> bool {
        let active = self.companion().active_slots();
        self.pressure
            .lock()
            .map(|mut pressure| pressure.admit_one(active))
            .unwrap_or(false)
    }
    fn observe(&self) {
        if let Ok(mut pressure) = self.pressure.lock() {
            pressure.observe();
        }
    }
    async fn next_source(&self) -> Result<Option<FastSource>, &'static str> {
        match self.execution.unclaimed_fast_source(false).await {
            Ok(source) => Ok(source),
            Err(RuntimeStoreError::Fenced | RuntimeStoreError::Expired)
                if self.execution.fast_window_due() =>
            {
                Ok(None)
            }
            Err(_) => Err("Fast input eligibility unavailable"),
        }
    }
    async fn present(self: Arc<Self>, source: FastSource) -> Result<SlotEnd, &'static str> {
        self.execution
            .present_auxiliary(source, self.shutdown.clone())
            .await
    }
}

impl ConfiguredExecution {
    /// One auxiliary presentation: fresh slot session, one exact owner input,
    /// then retirement of that used session while its reap witness is held.
    async fn present_auxiliary(
        &self,
        source: FastSource,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<SlotEnd, &'static str> {
        let mut heartbeat = Instant::now();
        let (ready, input) = match self
            .setup_auxiliary(&source, &mut shutdown, &mut heartbeat)
            .await
        {
            Ok(Some(setup)) => setup,
            Ok(None) => return Ok(SlotEnd::Unstarted),
            Err(_) if self.fast_window_due() || *shutdown.borrow() => {
                return Ok(SlotEnd::Unstarted)
            }
            Err(reason) => return Ok(SlotEnd::SetupFailed(reason)),
        };
        let live = match ready
            .dispatch_or_refused(&self.token, &input)
            .await
            .map_err(|_| "Fast slot dispatch refused; reconciliation required")?
        {
            Ok(started) => fast::started(started)?,
            // Core refused the admission itself (e.g. a Stop hold placed
            // during setup, or the input was presented elsewhere): no run
            // exists. Retire this unused setup and end only this slot.
            Err((ready, _)) => {
                self.reap_fast_setup(
                    ready
                        .retire_setup()
                        .map_err(|_| "Fast slot setup retirement refused")?,
                    &mut heartbeat,
                )
                .await?;
                return Ok(SlotEnd::SetupFailed("Fast slot admission refused"));
            }
        };
        let (run, proof) = match self
            .drive_fast(live, &mut shutdown, &mut heartbeat, true)
            .await?
        {
            fast::FastExit::Accepted { run, proof } | fast::FastExit::Stopped { run, proof } => {
                (run, proof)
            }
            fast::FastExit::Shutdown => return Err("Fast slot terminal remains unresolved"),
        };
        // The original non-Clone witness stays alive through this retirement
        // and then with the companion through Core and manager close.
        self.store
            .retire_bounded_fast_slot(&self.token, &run)
            .await
            .map_err(|_| "Fast slot retirement refused")?;
        Ok(SlotEnd::Presented(Some(proof)))
    }

    /// Everything before admission. `None`: every slot is live or the window
    /// closes first. An error here never touched a run. A setup record left
    /// behind keeps its slot until window close retires it, and any child
    /// stays in the window's custody accounting.
    async fn setup_auxiliary(
        &self,
        source: &FastSource,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<(crate::fast_execution::ReadyFast, FastAdmissionInput)>, &'static str> {
        let (binding, slot) = match self.store.allocate_bounded_fast_slot(&self.token).await {
            Ok(allocated) => allocated,
            // Every slot is live (e.g. unresolved leftovers): the canonical
            // lineage still presents this input in order.
            Err(RuntimeStoreError::Busy) => return Ok(None),
            Err(_) => return Err("Fast slot allocation refused"),
        };
        let directory = directory::window_fast_slot(&self.directory, slot)?;
        self.bind_workspace(&binding).await?;
        let grant = match &self.workspace_grant {
            Some(workspace) => {
                self.store
                    .authorize_bounded_fast_metadata_with_workspace(
                        &self.token,
                        &binding,
                        workspace,
                    )
                    .await
            }
            None => {
                self.store
                    .authorize_bounded_fast_metadata(&self.token, &binding)
                    .await
            }
        }
        .map_err(|_| "Fast slot setup authority refused")?;
        let Some(ready) = self
            .prepare_fast_in(grant, &directory, shutdown, heartbeat)
            .await?
        else {
            return Ok(None);
        };
        let Some(input) = self.slot_input(&binding, source, shutdown).await? else {
            self.reap_fast_setup(
                ready
                    .retire_setup()
                    .map_err(|_| "Fast slot setup retirement refused")?,
                heartbeat,
            )
            .await?;
            return Ok(None);
        };
        Ok(Some((ready, input)))
    }

    /// The exact input for this slot's ready session, or `None` when the
    /// window closes (or the companion failed) before dispatch.
    async fn slot_input(
        &self,
        binding: &orkestr_v2_application::runtime::Binding,
        source: &FastSource,
        shutdown: &watch::Receiver<bool>,
    ) -> Result<Option<FastAdmissionInput>, &'static str> {
        let companion = self
            .companion
            .as_deref()
            .ok_or("Fast slot lost its companion")?;
        if *shutdown.borrow() || self.fast_window_due() || companion.has_failed() {
            return Ok(None);
        }
        let ready = self
            .store
            .bounded_fast_slot_binding(&self.token, &binding.session_id)
            .await
            .map_err(|_| "Fast slot binding unavailable")?;
        if ready.state != orkestr_v2_application::runtime::SessionState::Ready {
            return Err("Fast slot binding is not ready");
        }
        Ok(Some(FastAdmissionInput {
            source_message_id: source.message_id.clone(),
            request_key: format!("fast-http:{}", source.event_id),
            source_event_id: source.event_id.clone(),
            fast_binding_id: ready.session_id,
            expected_binding_generation: ready.generation,
        }))
    }
}

#[cfg(test)]
#[path = "fast_pool_tests.rs"]
mod tests;
