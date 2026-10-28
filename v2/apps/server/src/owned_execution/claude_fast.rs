//! Claude Fast companion in a Claude window: the same immutable owner input is
//! presented on a distinct Fast native binding. Each presentation is a new
//! native process resuming the Fast session after explicit owner acceptance.
use super::{claude::ClaudeExit, window_roles::Companion, *};
use crate::{execution_registry::ExecutionScope, fast_execution::FastDispatch};
use orkestr_v2_application::runtime::RuntimeStore;
use std::time::Instant;

impl ConfiguredExecution {
    /// Attach the Claude Fast companion when the operator enabled it.
    pub(super) fn attach_claude_fast(
        &mut self,
        home: &Path,
        config: &crate::beta_config::BetaConfig,
    ) -> Result<(), &'static str> {
        if !config.claude.as_ref().is_some_and(|claude| claude.fast) {
            return Ok(());
        }
        let context = self
            .window
            .clone()
            .ok_or("Claude Fast composition requires a window")?;
        let control = crate::control_registry::ControlRegistry::new(
            self.owner.clone(),
            config.conversation_id.clone(),
        );
        let companion = Companion::new(ExecutionScope {
            store: self.store.clone(),
            control: Some(control.clone()),
            tasks: None,
        });
        let fast_config = config::Config {
            schema_version: 1,
            mode: "isolated_acceptance".into(),
            conversation_id: config.conversation_id.clone(),
            machine_token_file: PathBuf::new(),
            launcher: self.config.launcher.clone(),
            launcher_sha256: self.config.launcher_sha256.clone(),
            workspace: self.config.workspace.clone(),
            workspace_authority: None,
            namespace: config.namespace.clone(),
            supervisor_key: config.supervisor_key.clone(),
            provider: config::Provider::Claude,
            role: config::ExecutionRole::Fast,
            execution_budget: budget::ExecutionBudget {
                // Fast stays quick; long work belongs to Deep or a Worker.
                max_run_ms: FAST_MAX_RUN_MS,
                max_idle_ms: None,
            },
            worker: None,
        };
        let fast = Self {
            config: fast_config,
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
            workspace_grant: None,
            window: Some(context),
            window_workers: None,
            companion: Some(companion.clone()),
            window_activated: std::sync::atomic::AtomicBool::new(false),
            fast_factory: None,
            deep_slots: None,
            parallel_factory: None,
        };
        self.companion = Some(companion);
        self.fast_factory = Some(Box::new(fast));
        Ok(())
    }

    pub(super) async fn run_claude_fast(
        mut self,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), &'static str> {
        self.current().await?;
        let mut heartbeat = Instant::now();
        let companion = self
            .companion
            .clone()
            .ok_or("Claude Fast requires its window companion")?;
        let binding = self
            .store
            .ensure_role_bindings(&self.owner, &self.config.conversation_id)
            .await
            .map_err(|_| "Fast bindings unavailable")?
            .fast;
        let mut grant = self
            .store
            .authorize_window_fast_metadata(&self.token, &binding)
            .await
            .map_err(|_| "Claude Fast window setup authority refused")?;
        self.initial_grant = None;
        loop {
            let Some(ready) = self
                .prepare_claude(grant, &mut shutdown, &mut heartbeat)
                .await?
            else {
                return Ok(());
            };
            if !companion.claim_ready() {
                return Err(super::fast::ABANDONED);
            }
            self.wait_window_active(&mut shutdown, &mut heartbeat)
                .await?;
            let Some(input) = self.fast_input(&mut shutdown, &mut heartbeat).await? else {
                return Ok(());
            };
            if !companion.claim_start() {
                return Err(super::fast::ABANDONED);
            }
            let capability =
                match crate::fast_execution::consume_fast(&self.store, &self.token, &input)
                    .await
                    .map_err(|_| "Claude Fast dispatch refused; reconciliation required")?
                {
                    FastDispatch::Consumed(capability) => capability,
                    FastDispatch::Replay | FastDispatch::ReconciliationRequired => {
                        return Err("Fast input already admitted; automatic redispatch refused")
                    }
                };
            companion.started();
            let Some(exit) = self
                .drive_claude_capability(ready, capability, &mut shutdown, &mut heartbeat)
                .await?
            else {
                return Ok(());
            };
            let (run, proof, stopped) = match exit {
                ClaudeExit::Accepted(run, proof) => (run, proof, false),
                ClaudeExit::Stopped(run, proof) => (run, proof, true),
                ClaudeExit::WindowClosed => return Ok(()),
            };
            // Wait for the next presentation; without one the companion hands
            // its exact reap witness to the Deep owner's window retirement.
            if self
                .fast_source(&mut shutdown, &mut heartbeat)
                .await?
                .is_none()
            {
                return if stopped {
                    self.retire_stopped_claude_fast(&run, proof)
                } else {
                    self.retire_terminal(&run, proof).await
                };
            }
            let binding = self
                .store
                .ensure_role_bindings(&self.owner, &self.config.conversation_id)
                .await
                .map_err(|_| "Fast continuation binding unavailable")?
                .fast;
            grant = if stopped {
                self.store
                    .authorize_stopped_session_metadata(&self.token, &run, &binding)
                    .await
                    .map_err(|_| "Claude Fast stopped-session continuation refused")?
            } else {
                self.store
                    .authorize_accepted_session_metadata(&self.token, &run, &binding)
                    .await
                    .map_err(|_| "Claude Fast accepted-session continuation refused")?
            };
            drop(proof);
        }
    }

    fn retire_stopped_claude_fast(
        &self,
        run: &orkestr_v2_contracts::RunId,
        proof: orkestr_runtime::containment::ReapedBroker,
    ) -> Result<(), &'static str> {
        if proof.scope().run() != run.to_string() {
            return Err("Claude Fast stopped retirement scope mismatch");
        }
        let companion = self
            .companion
            .as_ref()
            .ok_or("Claude Fast requires its window companion")?;
        companion.retire();
        companion.retain(proof)
    }
}
