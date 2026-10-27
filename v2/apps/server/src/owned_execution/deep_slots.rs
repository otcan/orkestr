//! Read-only parallel Deep slots of one live window (docs/v2/parallel-deep.md).
//!
//! While the canonical writer runs a turn and the owner's `parallel_deep`
//! switch is on, the pool starts at most three fresh read-only Deep natives,
//! each answering exactly one queued owner chat input. A slot launches on the
//! read-only (Fast) service profile and its connection requests and requires
//! the read-only sandbox, so it can never write or act. Core decides every
//! claim, admission, acceptance and retirement; the pool only paces starts
//! by live host pressure. The writer waits for every slot to finish before
//! its window closes, and the owner's Stop of the writer stops every slot.
use super::*;
use orkestr_runtime::containment::{metadata::ReapedMetadata, ReapedBroker};
use orkestr_runtime::execution::PreparingCodex;
use orkestr_v2_application::runtime::{
    AdmissionDisposition, DispatchClaimResult, RuntimeStore, RuntimeStoreError,
};
use orkestr_v2_contracts::ExecutionPhase;
use orkestr_v2_store_sqlite::{ExecutionConsumption, MAX_PARALLEL_DEEP_SLOTS};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

/// Host-wide backstop across all windows; live pressure is the real limit.
const HOST_BACKSTOP: usize = 8;
static HOST_SLOTS: AtomicUsize = AtomicUsize::new(0);
const POLL: Duration = Duration::from_millis(200);
/// How long one read of the owner's switch stays current.
const SWITCH_READ: Duration = Duration::from_secs(2);

/// Custody shared by the writer and the pool.
pub(super) struct DeepSlots {
    home: PathBuf,
    retiring: AtomicBool,
    /// The writer's turn was stopped: every live slot stops too.
    stopping: AtomicBool,
    active: AtomicUsize,
    /// A slot is setting up and has not claimed yet: start no other, so a
    /// queued input never gets two natives.
    setting_up: AtomicBool,
    proofs: Mutex<Vec<ReapedBroker>>,
    setup_proofs: Mutex<Vec<ReapedMetadata>>,
}

/// Original witnesses the writer holds through Core and manager close.
pub(super) struct SlotProofs {
    _runs: Vec<ReapedBroker>,
    _setups: Vec<ReapedMetadata>,
}

impl DeepSlots {
    pub(super) fn new(home: &Path) -> Arc<Self> {
        Arc::new(Self {
            home: home.to_path_buf(),
            retiring: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            setting_up: AtomicBool::new(false),
            proofs: Mutex::new(Vec::new()),
            setup_proofs: Mutex::new(Vec::new()),
        })
    }
    /// The window closes: start nothing new.
    pub(super) fn retire(&self) {
        self.retiring.store(true, Ordering::Release);
    }
    pub(super) fn retiring(&self) -> bool {
        self.retiring.load(Ordering::Acquire)
    }
    pub(super) fn stop_all(&self) {
        self.stopping.store(true, Ordering::Release);
    }
    pub(super) fn stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }
    pub(super) fn active(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
    fn enter(&self) -> bool {
        if self.retiring()
            || self.stopping()
            || self
                .setting_up
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return false;
        }
        let entered = self
            .active
            .try_update(Ordering::AcqRel, Ordering::Acquire, |live| {
                (live < usize::from(MAX_PARALLEL_DEEP_SLOTS)).then_some(live + 1)
            })
            .is_ok();
        if !entered {
            self.set_up();
        }
        entered
    }
    /// This slot claimed its input (or gave up): another may set up now.
    fn set_up(&self) {
        self.setting_up.store(false, Ordering::Release);
    }
    fn leave(&self, proof: Option<ReapedBroker>, setup: Option<ReapedMetadata>) {
        if let Ok(mut proofs) = self.proofs.lock() {
            proofs.extend(proof);
        }
        if let Ok(mut proofs) = self.setup_proofs.lock() {
            proofs.extend(setup);
        }
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
    fn take(&self) -> SlotProofs {
        SlotProofs {
            _runs: self
                .proofs
                .lock()
                .map(|mut proofs| std::mem::take(&mut *proofs))
                .unwrap_or_default(),
            _setups: self
                .setup_proofs
                .lock()
                .map(|mut proofs| std::mem::take(&mut *proofs))
                .unwrap_or_default(),
        }
    }
}

fn finished(
    joined: Result<Result<(), &'static str>, tokio::task::JoinError>,
) -> Result<(), &'static str> {
    joined.map_err(|_| "parallel Deep slot task lost")?
}

/// Clears the pool's one-setup-at-a-time flag exactly once.
struct SettingUp<'a>(&'a DeepSlots, bool);
impl SettingUp<'_> {
    fn done(&mut self) {
        if !self.1 {
            self.1 = true;
            self.0.set_up();
        }
    }
}
impl Drop for SettingUp<'_> {
    fn drop(&mut self) {
        self.done();
    }
}

struct HostSlot;
impl HostSlot {
    fn acquire() -> Option<Self> {
        HOST_SLOTS
            .try_update(Ordering::AcqRel, Ordering::Acquire, |live| {
                (live < HOST_BACKSTOP).then_some(live + 1)
            })
            .ok()
            .map(|_| Self)
    }
}
impl Drop for HostSlot {
    fn drop(&mut self) {
        HOST_SLOTS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// How one slot ended.
enum SlotEnd {
    /// Nothing was admitted (no input left, the window closed, setup failed).
    Unstarted(Option<ReapedMetadata>),
    /// A run finished (accepted, stopped or failed) and its child was reaped.
    Ran(Option<ReapedBroker>),
}

impl ConfiguredExecution {
    /// Writer side: wait until every started slot finished its own close,
    /// then keep their witnesses through window close.
    pub(super) async fn drain_deep_slots(&self) -> Result<Option<SlotProofs>, &'static str> {
        let Some(slots) = &self.deep_slots else {
            return Ok(None);
        };
        // The window closes: start nothing, and stop every live slot turn.
        slots.retire();
        slots.stop_all();
        let mut heartbeat = Instant::now();
        while slots.active() != 0 {
            self.maintain(&mut heartbeat).await?;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(Some(slots.take()))
    }

    /// The pool: one task per window, started only on a Codex window with
    /// the read-only service profile configured.
    pub(super) async fn run_deep_slots(
        self,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), &'static str> {
        let this = Arc::new(self);
        let slots = this
            .deep_slots
            .clone()
            .ok_or("parallel Deep pool lacks custody")?;
        let mut pressure = super::host_pressure::HostPressure::new();
        let mut switch: Option<(Instant, bool)> = None;
        let mut tasks = tokio::task::JoinSet::new();
        let mut failure = None;
        loop {
            while let Some(joined) = tasks.try_join_next() {
                if let Err(error) = finished(joined) {
                    failure.get_or_insert(error);
                }
            }
            if *shutdown.borrow()
                || slots.retiring()
                || this.window.as_ref().is_none_or(|window| window.work_due())
            {
                break;
            }
            pressure.observe();
            // The owner's Stop of the writer stops every parallel turn.
            if let Ok(Some(status)) = this
                .store
                .execution_status(&this.owner, &this.config.conversation_id)
                .await
            {
                if matches!(
                    status.phase,
                    ExecutionPhase::CancelRequested | ExecutionPhase::Cancelled
                ) {
                    slots.stop_all();
                }
            }
            if !slots.stopping() && slots.active() < usize::from(MAX_PARALLEL_DEEP_SLOTS) {
                let enabled = match switch {
                    Some((at, enabled)) if at.elapsed() < SWITCH_READ => enabled,
                    _ => {
                        // Any doubt (busy or unavailable Store) means off now.
                        let enabled = this
                            .store
                            .parallel_deep_enabled(&this.token)
                            .await
                            .unwrap_or(false);
                        switch = Some((Instant::now(), enabled));
                        enabled
                    }
                };
                if enabled
                    && this
                        .store
                        .parallel_deep_candidate(&this.token)
                        .await
                        .unwrap_or(false)
                    && pressure
                        .admit_one_deep(slots.active().max(HOST_SLOTS.load(Ordering::Acquire)))
                {
                    if let Some(backstop) = HostSlot::acquire() {
                        if slots.enter() {
                            let this = this.clone();
                            let slots = slots.clone();
                            let shutdown = shutdown.clone();
                            tasks.spawn(async move {
                                let _backstop = backstop;
                                let result = this.present_parallel(&slots, shutdown).await;
                                match result {
                                    Ok(SlotEnd::Unstarted(setup)) => {
                                        slots.leave(None, setup);
                                        Ok(())
                                    }
                                    Ok(SlotEnd::Ran(proof)) => {
                                        slots.leave(proof, None);
                                        Ok(())
                                    }
                                    Err(error) => {
                                        slots.leave(None, None);
                                        Err(error)
                                    }
                                }
                            });
                        }
                    }
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(POLL) => {},
                _ = shutdown.changed() => {},
            }
        }
        // Drain: every started slot finishes its own exact close.
        while let Some(joined) = tasks.join_next().await {
            if let Err(error) = finished(joined) {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    /// One slot: fresh read-only native, one claimed input, one turn.
    async fn present_parallel(
        &self,
        slots: &DeepSlots,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<SlotEnd, &'static str> {
        let mut heartbeat = Instant::now();
        // Until this slot claimed its input (or gave up), no other sets up.
        let mut setting_up = SettingUp(slots, false);
        let (binding, slot) = match self.store.allocate_parallel_deep_slot(&self.token).await {
            Ok(allocated) => allocated,
            // Every slot is live, the switch went off or the window closes.
            Err(RuntimeStoreError::Busy | RuntimeStoreError::Fenced) => {
                return Ok(SlotEnd::Unstarted(None))
            }
            Err(_) => return Err("parallel Deep slot allocation refused"),
        };
        let directory =
            directory::window_deep_slot(&slots.home, &self.config.conversation_id, slot)?;
        let grant = self
            .store
            .authorize_parallel_deep_metadata(&self.token, &binding)
            .await
            .map_err(|_| "parallel Deep setup authority refused")?;
        let directories = orkestr_runtime::containment::ChildDirectories::new(
            &self.config.workspace,
            &directory.join("home"),
            &directory.join("tmp"),
        )
        .map_err(|_| "parallel Deep child directories unavailable")?;
        let context = self
            .window
            .clone()
            .ok_or("parallel Deep requires a window")?;
        let store = self.store.clone();
        let launcher = self.config.launcher.clone();
        let workspace = self.config.workspace.clone();
        let resources = self.children.retain();
        let mut setup = tokio::task::spawn_blocking(move || {
            PreparingCodex::open_window_parallel_deep_retained(
                store,
                grant,
                &launcher,
                &workspace,
                directories,
                resources,
                move |child| context.bind(&child),
            )
        })
        .await
        .map_err(|_| "parallel Deep setup worker lost")?
        .map_err(|_| "parallel Deep broker setup refused")?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            self.maintain(&mut heartbeat).await?;
            if setup
                .poll()
                .map_err(|_| "parallel Deep broker readiness refused")?
            {
                break;
            }
            if *shutdown.borrow() || Instant::now() >= deadline {
                let retiring = setup
                    .retire_setup()
                    .map_err(|_| "parallel Deep setup retirement refused")?;
                return self.unused(retiring, &binding, &mut heartbeat).await;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let ready = setup
            .confirm()
            .await
            .map_err(|_| "parallel Deep readiness commit refused")?;
        let ready_binding = self
            .store
            .parallel_deep_slot_binding(&self.token, &binding.session_id)
            .await
            .map_err(|_| "parallel Deep slot binding unavailable")?;
        let claim = if *shutdown.borrow() || slots.stopping() || slots.retiring() {
            None
        } else {
            self.store
                .claim_parallel_deep_input(&self.token, &ready_binding.session_id)
                .await
                .map_err(|_| "parallel Deep claim refused")?
        };
        setting_up.done();
        let Some(claim) = claim else {
            let retiring = ready
                .retire_setup()
                .map_err(|_| "parallel Deep setup retirement refused")?;
            return self.unused(retiring, &binding, &mut heartbeat).await;
        };
        let key = format!("parallel:{}", claim.event_id);
        let admitted = self
            .store
            .admit_run(
                &claim,
                &ready_binding.session_id,
                ready_binding.generation,
                &key,
            )
            .await
            .map_err(|_| "parallel Deep admission refused")?;
        if admitted.disposition != AdmissionDisposition::FreshCandidate {
            return Err("parallel Deep admission requires reconciliation");
        }
        let DispatchClaimResult::Reserved(reservation) = self
            .store
            .claim_provider_dispatch(&admitted, &key)
            .await
            .map_err(|_| "parallel Deep reservation refused")?
        else {
            return Err("parallel Deep reservation requires reconciliation");
        };
        let ExecutionConsumption::Dispatch(capability) = self
            .store
            .consume_execution(&reservation)
            .await
            .map_err(|_| "parallel Deep consumption refused")?
        else {
            return Err("parallel Deep delivery is uncertain; automatic replay refused");
        };
        let run = capability.provider().run.run_id.clone();
        let proof = self
            .drive_parallel(capability, ready, slots, &mut shutdown, &mut heartbeat)
            .await?;
        // A deferred answer, or a failed turn, returns its input to the
        // writer's queue (Core decides; a Stop keeps it with the turn).
        if let Ok(true) = self
            .store
            .defer_parallel_deep_input(&self.token, &run)
            .await
        {
            eprintln!("parallel Deep slot returned its input to the writer");
        }
        if proof.is_some() {
            // Accepted or Stopped: retire the used session now. A failed or
            // lapsed one retires with the window's context.
            let _ = self
                .store
                .retire_parallel_deep_slot(&self.token, &run)
                .await;
        }
        Ok(SlotEnd::Ran(proof))
    }

    /// Reap an unused slot native and free its slot.
    async fn unused(
        &self,
        mut retiring: orkestr_runtime::containment::metadata::RetiringMetadata,
        binding: &orkestr_v2_application::runtime::Binding,
        heartbeat: &mut Instant,
    ) -> Result<SlotEnd, &'static str> {
        let deadline = Instant::now() + Duration::from_secs(3);
        let proof = loop {
            self.maintain(heartbeat).await?;
            if let Some(proof) = retiring
                .poll_reaped()
                .map_err(|_| "parallel Deep setup cleanup remains uncertain")?
            {
                break proof;
            }
            if Instant::now() >= deadline {
                return Err("parallel Deep setup cleanup timed out");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        let _ = self
            .store
            .retire_unused_parallel_deep_slot(&self.token, &binding.session_id)
            .await;
        Ok(SlotEnd::Unstarted(Some(proof)))
    }

    /// One read-only turn on its own native. Returns the reap witness after
    /// owner acceptance or a confirmed Stop; `None` when the run failed and
    /// its child was dropped (Core keeps the terminal truth).
    async fn drive_parallel(
        &self,
        capability: Box<orkestr_v2_store_sqlite::ConsumedProviderDispatch>,
        ready: orkestr_runtime::execution::ReadyCodex,
        slots: &DeepSlots,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<ReapedBroker>, &'static str> {
        let conversation = &self.config.conversation_id;
        let run = capability.provider().run.run_id.clone();
        let mut liveness = liveness::RunningLease::capture(&self.store, &capability).await?;
        let (mut authority, mut pump) = ready
            .attach(self.store.clone(), capability)
            .map_err(|_| "parallel Deep attachment is uncertain; automatic replay refused")?;
        let (run_control, mut controls) = self
            .control
            .register(self.store.clone(), &run)
            .map_err(|_| "parallel Deep control registration refused")?;
        let mut budget = self.config.execution_budget.start(Instant::now());
        let mut peak = 0;
        let result = loop {
            self.maintain(heartbeat).await?;
            if let Some(bytes) = pump.tree_peak_rss_bytes() {
                peak = peak.max(bytes);
            }
            let schedule = run_control.serialize().await;
            let status = self
                .store
                .execution_run_status(&self.token, &self.owner, conversation, &run)
                .await
                .map_err(|_| "parallel Deep status unavailable")?
                .ok_or("parallel Deep status missing")?;
            run_control
                .set_available(status.phase == ExecutionPhase::Running && pump.pending().is_none());
            match status.phase {
                ExecutionPhase::CancelRequested => {
                    run_control.disable();
                    drop(schedule);
                    let proof = self
                        .stop_owned(&mut controls, authority, pump, &run, heartbeat)
                        .await?;
                    break Some(proof);
                }
                ExecutionPhase::Completed => {
                    drop(schedule);
                    let retiring = pump
                        .retire_broker()
                        .map_err(|_| "parallel Deep accepted retirement refused")?;
                    drop(authority);
                    break Some(self.reaped(retiring, &run, heartbeat).await?);
                }
                ExecutionPhase::AwaitingAcceptance => {
                    drop(schedule);
                    pump.check_broker_liveness().map_err(|_| {
                        "parallel Deep proposal broker exited; reconciliation required"
                    })?;
                    // Auto-acceptance (required for parallel turns) decides;
                    // shutdown leaves the proposal to stranded handling.
                    if *shutdown.borrow() {
                        break None;
                    }
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                        _ = shutdown.changed() => {},
                    }
                    continue;
                }
                ExecutionPhase::Failed | ExecutionPhase::Blocked | ExecutionPhase::Cancelled => {
                    drop(schedule);
                    break None;
                }
                _ => {}
            }
            let cancellation = if self.window.as_ref().is_some_and(|window| window.work_due()) {
                Some("execution-window-work-deadline")
            } else if *shutdown.borrow() {
                Some("isolated-runtime-shutdown")
            } else if slots.stopping() || slots.retiring() {
                Some("parallel-deep-writer-stopped")
            } else {
                budget.cancellation_key(Instant::now())
            };
            if let Some(key) = cancellation {
                // Fence durably before local child cleanup; this holds no
                // other input (a slot's own Stop).
                let receipt = self
                    .store
                    .request_cancel(&self.owner, &run, key)
                    .await
                    .map_err(|_| "parallel Deep cancellation requires reconciliation")?;
                run_control.disable();
                run_control
                    .publish(receipt)
                    .map_err(|_| "parallel Deep Stop handoff requires reconciliation")?;
                drop(schedule);
                let proof = self
                    .stop_owned(&mut controls, authority, pump, &run, heartbeat)
                    .await?;
                break Some(proof);
            }
            if pump.pending().is_none() {
                pump.flush()
                    .map_err(|_| "parallel Deep write fence refused")?;
            }
            match pump.step(&self.store).await {
                Ok(true) => budget.observed(Instant::now()),
                Ok(false)
                | Err(orkestr_runtime::supervisor::Error::Store(
                    RuntimeStoreError::Busy | RuntimeStoreError::Unavailable,
                )) => {}
                Err(error) => {
                    super::observation_refused("parallel Deep", &error);
                    return Err("parallel Deep observation refused; reconciliation required");
                }
            }
            if status.phase == ExecutionPhase::Running
                && liveness.due(Instant::now())
                && pump.renewal_quiescent()
            {
                let (next_authority, next_pump) =
                    match liveness.refresh_plain(self.store.clone(), pump).await {
                        Ok(refreshed) => refreshed,
                        Err(reason) => {
                            run_control.disable();
                            return Err(reason);
                        }
                    };
                let _ = authority.revoke();
                authority = next_authority;
                pump = next_pump;
            }
            run_control
                .set_available(status.phase == ExecutionPhase::Running && pump.pending().is_none());
            drop(schedule);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => {},
            }
        };
        // The measured cost of one more concurrent read-only Deep native.
        super::host_pressure::record_deep_slot_peak(peak);
        Ok(result)
    }
}
