//! One Fast companion shares the window, never its native identity or reap proof.
//! Its canonical lineage may be joined by bounded auxiliary slots, each with
//! its own fresh native session, scratch directory and original reap witness.
use super::*;
use crate::execution_registry::ExecutionScope;
use orkestr_runtime::containment::ReapedBroker;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

pub(super) struct Companion {
    scope: ExecutionScope,
    ready: AtomicBool,
    active: AtomicBool,
    started: AtomicBool,
    retiring: AtomicBool,
    failed: AtomicBool,
    /// Fast claimed its first dispatch (between input and `started`).
    starting: AtomicBool,
    /// Serializes Fast's claims with Deep's abandonment decision, so Fast
    /// never becomes ready or dispatches after Deep went on without it.
    setup: Mutex<()>,
    proof: Mutex<Option<ReapedBroker>>,
    setup_proofs: Mutex<Vec<orkestr_runtime::containment::metadata::ReapedMetadata>>,
    slots: Mutex<Slots>,
    /// The canonical lineage holds a ready native and waits for input.
    primary_idle: AtomicBool,
}

/// Auxiliary Fast custody of this window.
#[derive(Default)]
struct Slots {
    active: usize,
    /// Original auxiliary reap witnesses, kept through Core and manager close.
    proofs: Vec<ReapedBroker>,
    /// Owner inputs a Fast task selected but has not admitted yet.
    claims: std::collections::HashSet<orkestr_v2_contracts::EventId>,
    /// The claimed input the canonical lineage keeps across its own
    /// rotation to a fresh presentation: no extra slot may take it.
    lineage_hold: Option<orkestr_v2_contracts::EventId>,
}

/// Original witnesses Deep holds until window close completes.
pub(super) struct CompanionProofs {
    _lineage: Option<ReapedBroker>,
    _slots: Vec<ReapedBroker>,
}

/// How long Deep waits for each Fast setup stage before going on alone.
pub(super) const COMPANION_SETUP_TIMEOUT: Duration = Duration::from_secs(15);

impl Companion {
    pub(super) fn new(scope: ExecutionScope) -> Arc<Self> {
        Arc::new(Self {
            scope,
            ready: AtomicBool::new(false),
            active: AtomicBool::new(false),
            started: AtomicBool::new(false),
            retiring: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            starting: AtomicBool::new(false),
            setup: Mutex::new(()),
            proof: Mutex::new(None),
            setup_proofs: Mutex::new(Vec::new()),
            slots: Mutex::new(Slots::default()),
            primary_idle: AtomicBool::new(false),
        })
    }
    pub(super) fn scope(&self) -> ExecutionScope {
        self.scope.clone()
    }
    /// Fast reports a ready native. `false`: Deep already went on without
    /// it, so the companion must not present anything in this window.
    pub(super) fn claim_ready(&self) -> bool {
        self.claim(&self.ready)
    }
    /// Fast is about to dispatch its first presentation. `false` as above.
    pub(super) fn claim_start(&self) -> bool {
        self.claim(&self.starting)
    }
    fn claim(&self, stage: &AtomicBool) -> bool {
        let Ok(_setup) = self.setup.lock() else {
            return false;
        };
        if self.failed.load(Ordering::Acquire) {
            return false;
        }
        stage.store(true, Ordering::Release);
        true
    }
    /// Deep's setup wait timed out: mark the companion failed unless Fast
    /// already claimed the awaited stage (`ready`, or a dispatch in flight).
    /// `true` when it is now failed and Deep proceeds alone.
    fn abandon(&self, ready: bool) -> bool {
        let Ok(_setup) = self.setup.lock() else {
            return false;
        };
        let claimed = if ready { &self.ready } else { &self.starting };
        if claimed.load(Ordering::Acquire) {
            return false;
        }
        self.failed.store(true, Ordering::Release);
        true
    }
    /// One step of Deep's wait for a Fast setup stage (`ready`: a ready
    /// native, else its first presentation). `None`: keep waiting.
    ///
    /// A failed companion never holds Deep. Core's window activation never
    /// needs Fast either: Fast waits for Deep's activation, not the reverse.
    /// So a Fast that neither reached the stage nor failed in time (for
    /// example one that never got its presentation) is failed here and Deep
    /// keeps the window alone. Deep keeps waiting only while a dispatch Fast
    /// already claimed is in flight; shutdown or the work deadline still end
    /// the setup.
    pub(super) fn setup_progress(
        &self,
        ready: bool,
        interrupted: bool,
        timed_out: bool,
    ) -> Option<Result<(), &'static str>> {
        let observed = if ready { &self.ready } else { &self.started };
        if observed.load(Ordering::Acquire) || self.failed.load(Ordering::Acquire) {
            return Some(Ok(()));
        }
        if interrupted {
            return Some(Err("Fast companion setup incomplete"));
        }
        if timed_out && self.abandon(ready) {
            eprintln!(
                "owned window Fast companion failed: {} not reached in time; Deep continues alone",
                if ready {
                    "readiness"
                } else {
                    "first presentation"
                }
            );
            return Some(Ok(()));
        }
        None
    }
    pub(super) fn activate(&self) {
        self.active.store(true, Ordering::Release);
    }
    pub(super) fn started(&self) {
        self.started.store(true, Ordering::Release);
    }
    pub(super) fn retire(&self) {
        // Ordered with `enter_slot`: no auxiliary slot starts after this.
        let _setup = self.setup.lock();
        self.retiring.store(true, Ordering::Release);
    }
    /// Reserve one auxiliary slot. `false` once retiring or failed, so Deep's
    /// close never misses a slot that started after its retirement began.
    pub(super) fn enter_slot(&self) -> bool {
        let Ok(_setup) = self.setup.lock() else {
            return false;
        };
        if self.retiring.load(Ordering::Acquire)
            || self.failed.load(Ordering::Acquire)
            || !self.started.load(Ordering::Acquire)
        {
            return false;
        }
        let Ok(mut slots) = self.slots.lock() else {
            return false;
        };
        slots.active += 1;
        true
    }
    /// A slot ended; its original reap witness (if it launched) stays here.
    pub(super) fn leave_slot(&self, proof: Option<ReapedBroker>) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.active = slots.active.saturating_sub(1);
            slots.proofs.extend(proof);
        } else {
            self.fail();
        }
    }
    pub(super) fn active_slots(&self) -> usize {
        self.slots.lock().map_or(usize::MAX, |slots| slots.active)
    }
    /// One Fast task per owner input: `false` when another task holds it.
    pub(super) fn claim_source(&self, event: &orkestr_v2_contracts::EventId) -> bool {
        self.slots
            .lock()
            .is_ok_and(|mut slots| slots.claims.insert(event.clone()))
    }
    pub(super) fn is_claimed(&self, event: &orkestr_v2_contracts::EventId) -> bool {
        self.slots
            .lock()
            .map_or(true, |slots| slots.claims.contains(event))
    }
    /// Keep this claimed input for the lineage's next presentation.
    pub(super) fn hold_for_lineage(&self, event: &orkestr_v2_contracts::EventId) {
        if let Ok(mut slots) = self.slots.lock() {
            if slots.claims.contains(event) {
                slots.lineage_hold = Some(event.clone());
            }
        }
    }
    pub(super) fn lineage_holds(&self, event: &orkestr_v2_contracts::EventId) -> bool {
        self.slots
            .lock()
            .is_ok_and(|slots| slots.lineage_hold.as_ref() == Some(event))
    }
    /// The lineage takes its held input (it stays claimed).
    pub(super) fn take_lineage_hold(&self, event: &orkestr_v2_contracts::EventId) -> bool {
        self.slots.lock().is_ok_and(|mut slots| {
            if slots.lineage_hold.as_ref() == Some(event) {
                slots.lineage_hold = None;
                true
            } else {
                false
            }
        })
    }
    /// After admission committed (Core then excludes the source) or abandon.
    pub(super) fn release_source(&self, event: &orkestr_v2_contracts::EventId) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.claims.remove(event);
            if slots.lineage_hold.as_ref() == Some(event) {
                slots.lineage_hold = None;
            }
        }
    }
    pub(super) fn set_primary_idle(&self, idle: bool) {
        self.primary_idle.store(idle, Ordering::Release);
    }
    /// Another slot may start: the lineage presented first and is busy now.
    pub(super) fn wants_slot(&self) -> bool {
        self.started.load(Ordering::Acquire)
            && !self.primary_idle.load(Ordering::Acquire)
            && !self.retiring()
            && !self.has_failed()
    }
    pub(super) fn retiring(&self) -> bool {
        self.retiring.load(Ordering::Acquire)
    }
    pub(super) fn fail(&self) {
        self.failed.store(true, Ordering::Release);
    }
    pub(super) fn has_failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }
    pub(super) fn ready_to_close(&self) -> bool {
        self.started.load(Ordering::Acquire) && !self.failed.load(Ordering::Acquire)
    }
    pub(super) fn retain(&self, proof: ReapedBroker) -> Result<(), &'static str> {
        if !self.retiring() || !self.ready_to_close() {
            return Err("Fast companion retirement was not requested");
        }
        let mut retained = self
            .proof
            .lock()
            .map_err(|_| "Fast reap storage poisoned")?;
        if retained.is_some() {
            return Err("Fast reap proof already retained");
        }
        *retained = Some(proof);
        Ok(())
    }
    pub(super) fn retain_setup(
        &self,
        proof: orkestr_runtime::containment::metadata::ReapedMetadata,
    ) -> Result<(), &'static str> {
        // Kept on this companion through Core and manager close, independently
        // of whether a real Fast turn ever attached to this setup child.
        self.setup_proofs
            .lock()
            .map_err(|_| "Fast setup reap storage poisoned")?
            .push(proof);
        Ok(())
    }
    fn take(&self) -> Result<Option<ReapedBroker>, &'static str> {
        if self.failed.load(Ordering::Acquire) {
            return Err("Fast companion failed");
        }
        Ok(self
            .proof
            .lock()
            .map_err(|_| "Fast reap storage poisoned")?
            .take())
    }
}

impl ConfiguredExecution {
    pub(super) async fn wait_fast_acceptance(
        &self,
        run: &orkestr_v2_contracts::RunId,
        proof: ReapedBroker,
        heartbeat: &mut Instant,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Result<(), &'static str> {
        self.await_fast_accepted(run, heartbeat, shutdown).await?;
        self.retire_terminal(run, proof).await
    }

    /// A reaped proposal of a closing window: wait for the owner decision.
    pub(super) async fn await_fast_accepted(
        &self,
        run: &orkestr_v2_contracts::RunId,
        heartbeat: &mut Instant,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Result<(), &'static str> {
        loop {
            self.maintain(heartbeat).await?;
            match self.fast_status(run).await?.phase {
                orkestr_v2_contracts::ExecutionPhase::Completed => return Ok(()),
                orkestr_v2_contracts::ExecutionPhase::AwaitingAcceptance if !*shutdown.borrow() => {
                }
                _ => return Err("Fast owner decision remains unresolved"),
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                _ = shutdown.changed() => {},
            }
        }
    }

    pub(super) fn attach_window_roles(
        &mut self,
        home: &Path,
        config: &crate::beta_config::BetaConfig,
    ) -> Result<(), &'static str> {
        let Some(roles) = &config.roles else {
            return Ok(());
        };
        let context = self
            .window
            .clone()
            .ok_or("role composition requires a window")?;
        let control = crate::control_registry::ControlRegistry::new(
            self.owner.clone(),
            config.conversation_id.clone(),
        );
        let companion = Companion::new(ExecutionScope {
            store: self.store.clone(),
            control: Some(control.clone()),
            tasks: None,
        });
        let fast = Self {
            config: Config {
                schema_version: 1,
                mode: "isolated_acceptance".into(),
                conversation_id: config.conversation_id.clone(),
                machine_token_file: PathBuf::new(),
                launcher: roles.fast.launcher.clone(),
                launcher_sha256: roles.fast.launcher_sha256.clone(),
                workspace: roles.fast.workspace.clone(),
                workspace_authority: None,
                namespace: config.namespace.clone(),
                supervisor_key: config.supervisor_key.clone(),
                provider: config::Provider::Codex,
                role: config::ExecutionRole::Fast,
                execution_budget: budget::ExecutionBudget {
                    // Fast stays quick; long work belongs to Deep or a Worker.
                    max_run_ms: FAST_MAX_RUN_MS,
                    max_idle_ms: None,
                },
                worker: None,
            },
            store: self.store.clone(),
            owner: self.owner.clone(),
            token: self.token.clone(),
            directory: directory::window_fast(home, &config.conversation_id)?,
            control,
            tasks: self.tasks.clone(),
            children: self.children.clone(),
            worker_reaps: self.worker_reaps.clone(),
            offline_python: None,
            workspace_exec: None,
            initial_grant: None,
            workspace_grant: self.workspace_grant.clone(),
            window: Some(context),
            window_workers: None,
            companion: Some(companion.clone()),
            window_activated: std::sync::atomic::AtomicBool::new(false),
            fast_factory: None,
            deep_slots: None,
            parallel_factory: None,
        };
        self.config.worker = Some(
            if let Some(run_ms) = self
                .workspace_exec
                .as_ref()
                .and_then(|dispatcher| dispatcher.worker_run_ms())
            {
                crate::worker_execution::WorkerPolicy::window_trusted_workspace_tasks(run_ms)
            } else if self.workspace_exec.is_some() {
                crate::worker_execution::WorkerPolicy::window_workspace_tasks()
            } else {
                crate::worker_execution::WorkerPolicy::window_owner_tasks()
            },
        );
        self.companion = Some(companion);
        self.fast_factory = Some(Box::new(fast));
        // Read-only parallel Deep slots (docs/v2/parallel-deep.md) launch on
        // the read-only Fast service profile under this window's Deep context.
        // The pool starts nothing while the owner's `parallel_deep` is off.
        let slots = super::deep_slots::DeepSlots::new(home);
        let parallel = Self {
            config: Config {
                schema_version: 1,
                mode: "isolated_acceptance".into(),
                conversation_id: config.conversation_id.clone(),
                machine_token_file: PathBuf::new(),
                launcher: roles.fast.launcher.clone(),
                launcher_sha256: roles.fast.launcher_sha256.clone(),
                workspace: roles.fast.workspace.clone(),
                workspace_authority: None,
                namespace: self.config.namespace.clone(),
                supervisor_key: self.config.supervisor_key.clone(),
                provider: config::Provider::Codex,
                role: config::ExecutionRole::Deep,
                execution_budget: self.config.execution_budget.clone(),
                worker: None,
            },
            store: self.store.clone(),
            owner: self.owner.clone(),
            token: self.token.clone(),
            directory: self.directory.clone(),
            control: self.control.clone(),
            tasks: self.tasks.clone(),
            children: self.children.clone(),
            worker_reaps: self.worker_reaps.clone(),
            offline_python: None,
            workspace_exec: None,
            initial_grant: None,
            workspace_grant: None,
            window: self.window.clone(),
            window_workers: None,
            companion: None,
            window_activated: std::sync::atomic::AtomicBool::new(false),
            fast_factory: None,
            deep_slots: Some(slots.clone()),
            parallel_factory: None,
        };
        self.deep_slots = Some(slots);
        self.parallel_factory = Some(Box::new(parallel));
        Ok(())
    }

    pub(super) async fn run_window_roles(
        mut self,
        shutdown: watch::Receiver<bool>,
    ) -> Result<(), &'static str> {
        match self.fast_factory.take() {
            None => self.run(shutdown).await,
            Some(fast) => {
                // A lost or failed Fast companion fails alone: Deep (and its
                // Workers) keep the window. Core still decides retirement.
                let companion = self.companion.clone();
                let parallel = self.parallel_factory.take();
                let slots = self.deep_slots.clone();
                let side = {
                    let shutdown = shutdown.clone();
                    let companion = companion.clone();
                    async move {
                        // The parallel Deep pool is its own task (Core fences
                        // block in place) and fails alone: it then starts no
                        // slot, and the writer's close still waits for the
                        // started ones. Aborted with this role set.
                        let pool = parallel.map(|parallel| {
                            let shutdown = shutdown.clone();
                            AbortOnDrop(tokio::spawn(async move {
                                if let Err(reason) = parallel.run_deep_slots(shutdown).await {
                                    eprintln!("owned window parallel Deep pool failed: {reason}");
                                    if let Some(slots) = slots {
                                        slots.retire();
                                    }
                                }
                            }))
                        });
                        let fast = fast.run(shutdown).await;
                        // Report a failed Fast now, not after the pool ends:
                        // Deep must stop waiting on (and steering to) it.
                        if fast.is_err() {
                            if let Some(companion) = &companion {
                                companion.fail();
                            }
                        }
                        if let Some(mut pool) = pool {
                            let _ = (&mut pool.0).await;
                        }
                        fast
                    }
                };
                join_roles(self.run(shutdown.clone()), side, move |reason| {
                    eprintln!("owned window Fast companion failed: {reason}");
                    if let Some(companion) = companion {
                        companion.fail();
                    }
                })
                .await
            }
        }
    }

    pub(super) async fn wait_companion_setup(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
        ready: bool,
    ) -> Result<(), &'static str> {
        let Some(companion) = &self.companion else {
            return Ok(());
        };
        let deadline = Instant::now() + COMPANION_SETUP_TIMEOUT;
        loop {
            let interrupted =
                *shutdown.borrow() || self.window.as_ref().is_none_or(|window| window.work_due());
            if let Some(result) =
                companion.setup_progress(ready, interrupted, Instant::now() >= deadline)
            {
                return result;
            }
            self.maintain(heartbeat).await?;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// The Fast scope Deep installs at activation: none once the companion
    /// failed, so no control is ever routed to an abandoned Fast.
    pub(super) fn companion_scope(&self) -> Option<ExecutionScope> {
        self.companion
            .as_ref()
            .filter(|companion| !companion.has_failed())
            .map(|companion| companion.scope())
    }

    pub(super) async fn wait_window_active(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<(), &'static str> {
        let Some(companion) = &self.companion else {
            return Ok(());
        };
        let deadline = Instant::now() + COMPANION_SETUP_TIMEOUT;
        while !companion.active.load(Ordering::Acquire) {
            // Deep went on without this companion: it never presents here.
            if companion.has_failed() {
                return Err("Fast companion failed before Deep activation");
            }
            if *shutdown.borrow()
                || Instant::now() >= deadline
                || self.window.as_ref().is_none_or(|window| window.work_due())
            {
                return Err("Deep activation incomplete");
            }
            self.maintain(heartbeat).await?;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok(())
    }

    pub(super) fn fast_window_due(&self) -> bool {
        self.window.as_ref().is_some_and(|window| window.work_due())
            || self
                .companion
                .as_ref()
                .is_some_and(|companion| companion.retiring())
    }

    pub(super) async fn begin_role_retirement(&self) -> Result<(), &'static str> {
        if let Some(companion) = &self.companion {
            companion.retire();
        }
        if let Some(slots) = &self.deep_slots {
            slots.retire();
        }
        if let Some(window) = &self.window {
            window.begin_retirement(&self.store, &self.token).await?;
        }
        Ok(())
    }

    pub(super) async fn companion_reap(&self) -> Result<CompanionProofs, &'static str> {
        let Some(companion) = &self.companion else {
            return Ok(CompanionProofs {
                _lineage: None,
                _slots: Vec::new(),
            });
        };
        let mut heartbeat = Instant::now();
        loop {
            // A failed companion has no proof to hand over; Core's terminal
            // and retirement checks still refuse an unresolved Fast run.
            if companion.failed.load(Ordering::Acquire) {
                return Ok(CompanionProofs {
                    _lineage: None,
                    _slots: Vec::new(),
                });
            }
            // Every auxiliary slot finishes its own exact close first.
            if companion.active_slots() == 0 {
                if let Some(proof) = companion.take()? {
                    let slots = std::mem::take(
                        &mut companion
                            .slots
                            .lock()
                            .map_err(|_| "Fast slot storage poisoned")?
                            .proofs,
                    );
                    return Ok(CompanionProofs {
                        _lineage: Some(proof),
                        _slots: slots,
                    });
                }
            }
            // An unaccepted proposal keeps this metadata-only wait pending.
            // Auth and Core canonical terminal checks still decide retirement.
            self.maintain(&mut heartbeat).await?;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// A spawned role task that is aborted when its owning future is dropped.
struct AbortOnDrop(tokio::task::JoinHandle<()>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Each role enters synchronous Core fences with `block_in_place`. They must
/// have separate Tokio tasks: a sibling future in `try_join!` could otherwise
/// retain a SQLite transaction while the other blocks waiting for its release.
async fn join_roles(
    deep: impl std::future::Future<Output = Result<(), &'static str>> + Send + 'static,
    fast: impl std::future::Future<Output = Result<(), &'static str>> + Send + 'static,
    fast_failed: impl FnOnce(&'static str),
) -> Result<(), &'static str> {
    let mut roles = tokio::task::JoinSet::new();
    let deep = roles.spawn(deep).id();
    roles.spawn(fast);
    let mut fast_failed = Some(fast_failed);
    while let Some(joined) = roles.join_next_with_id().await {
        let (id, result) = match joined {
            Ok((id, result)) => (id, result),
            Err(error) => (error.id(), Err("window role task lost")),
        };
        let Err(error) = result else {
            continue;
        };
        if id != deep {
            // Fast fails alone; the Deep role keeps the window.
            if let Some(report) = fast_failed.take() {
                report(error);
            }
            continue;
        }
        roles.abort_all();
        while roles.join_next().await.is_some() {}
        return Err(error);
    }
    // JoinSet also aborts retained tasks if this owning future is cancelled.
    // Task completion never replaces the existing original-child reap barrier.
    Ok(())
}

#[cfg(test)]
#[path = "window_roles_tests.rs"]
mod tests;
