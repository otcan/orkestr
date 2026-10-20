//! One Fast companion shares the window, never its native identity or reap proof.
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
    proof: Mutex<Option<ReapedBroker>>,
}

impl Companion {
    fn new(scope: ExecutionScope) -> Arc<Self> {
        Arc::new(Self {
            scope,
            ready: AtomicBool::new(false),
            active: AtomicBool::new(false),
            started: AtomicBool::new(false),
            retiring: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            proof: Mutex::new(None),
        })
    }
    pub(super) fn scope(&self) -> ExecutionScope {
        self.scope.clone()
    }
    pub(super) fn ready(&self) {
        self.ready.store(true, Ordering::Release);
    }
    pub(super) fn activate(&self) {
        self.active.store(true, Ordering::Release);
    }
    pub(super) fn started(&self) {
        self.started.store(true, Ordering::Release);
    }
    pub(super) fn retire(&self) {
        self.retiring.store(true, Ordering::Release);
    }
    pub(super) fn retiring(&self) -> bool {
        self.retiring.load(Ordering::Acquire)
    }
    pub(super) fn fail(&self) {
        self.failed.store(true, Ordering::Release);
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
        loop {
            self.maintain(heartbeat).await?;
            match self.fast_status(run).await?.phase {
                orkestr_v2_contracts::ExecutionPhase::Completed => {
                    return self.retire_terminal(run, proof).await;
                }
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
                    max_run_ms: 870_000,
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
            fast_factory: None,
        };
        self.config.worker = Some(if self.workspace_exec.is_some() {
            crate::worker_execution::WorkerPolicy::window_workspace_tasks()
        } else {
            crate::worker_execution::WorkerPolicy::window_owner_tasks()
        });
        self.companion = Some(companion);
        self.fast_factory = Some(Box::new(fast));
        Ok(())
    }

    pub(super) async fn run_window_roles(
        mut self,
        shutdown: watch::Receiver<bool>,
    ) -> Result<(), &'static str> {
        match self.fast_factory.take() {
            None => self.run(shutdown).await,
            Some(fast) => {
                join_roles(self.run_codex(shutdown.clone()), fast.run_fast(shutdown)).await
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
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let observed = if ready {
                &companion.ready
            } else {
                &companion.started
            };
            if observed.load(Ordering::Acquire) {
                return Ok(());
            }
            if *shutdown.borrow()
                || Instant::now() >= deadline
                || companion.failed.load(Ordering::Acquire)
                || self.window.as_ref().is_none_or(|window| window.work_due())
            {
                return Err("Fast companion setup incomplete");
            }
            self.maintain(heartbeat).await?;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub(super) async fn wait_window_active(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<(), &'static str> {
        let Some(companion) = &self.companion else {
            return Ok(());
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while !companion.active.load(Ordering::Acquire) {
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
        if let Some(window) = &self.window {
            window.begin_retirement(&self.store, &self.token).await?;
        }
        Ok(())
    }

    pub(super) async fn companion_reap(&self) -> Result<Option<ReapedBroker>, &'static str> {
        let Some(companion) = &self.companion else {
            return Ok(None);
        };
        let mut heartbeat = Instant::now();
        loop {
            if let Some(proof) = companion.take()? {
                return Ok(Some(proof));
            }
            // An unaccepted proposal keeps this metadata-only wait pending.
            // Auth and Core canonical terminal checks still decide retirement.
            self.maintain(&mut heartbeat).await?;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// Each role enters synchronous Core fences with `block_in_place`. They must
/// have separate Tokio tasks: a sibling future in `try_join!` could otherwise
/// retain a SQLite transaction while the other blocks waiting for its release.
async fn join_roles(
    deep: impl std::future::Future<Output = Result<(), &'static str>> + Send + 'static,
    fast: impl std::future::Future<Output = Result<(), &'static str>> + Send + 'static,
) -> Result<(), &'static str> {
    let mut roles = tokio::task::JoinSet::new();
    roles.spawn(deep);
    roles.spawn(fast);
    while let Some(result) = roles.join_next().await {
        let result = result.unwrap_or(Err("window role task lost"));
        if let Err(error) = result {
            roles.abort_all();
            while roles.join_next().await.is_some() {}
            return Err(error);
        }
    }
    // JoinSet also aborts retained tasks if this owning future is cancelled.
    // Task completion never replaces the existing original-child reap barrier.
    Ok(())
}

#[cfg(test)]
#[path = "window_roles_tests.rs"]
mod tests;
