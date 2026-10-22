//! Independently scheduled presentations of canonical owner input.
use super::*;
use crate::fast_execution::{FastStart, LiveFast};
use orkestr_runtime::containment::ReapedBroker;
use orkestr_v2_application::runtime::{RuntimeStore, SessionState};
use orkestr_v2_contracts::RunId;
use orkestr_v2_store_sqlite::{FastAdmissionInput, FastSource};
use std::time::Instant;

/// Deep's setup wait gave up on this companion; it never presents here.
pub(super) const ABANDONED: &str = "Fast companion abandoned: Deep continued without it";

pub(super) enum FastExit {
    Shutdown,
    Stopped { run: RunId, proof: ReapedBroker },
}

impl ConfiguredExecution {
    pub(super) async fn run_fast(
        mut self,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), &'static str> {
        self.current().await?;
        let mut heartbeat = Instant::now();
        let mut grant = if let Some(grant) = self.initial_grant.take() {
            if self
                .fast_source(&mut shutdown, &mut heartbeat)
                .await?
                .is_none()
            {
                return Ok(());
            }
            grant
        } else {
            let binding = self
                .store
                .ensure_role_bindings(&self.owner, &self.config.conversation_id)
                .await
                .map_err(|_| "Fast bindings unavailable")?
                .fast;
            if binding.state != SessionState::Lost {
                self.bind_workspace(&binding).await?;
            }
            if self.window.is_some() {
                match &self.workspace_grant {
                    Some(workspace) => self
                        .store
                        .authorize_window_fast_metadata_with_workspace(
                            &self.token,
                            &binding,
                            workspace,
                        )
                        .await
                        .map_err(|_| "Fast window workspace setup authority refused")?,
                    None => self
                        .store
                        .authorize_window_fast_metadata(&self.token, &binding)
                        .await
                        .map_err(|_| "Fast window setup authority refused")?,
                }
            } else {
                self.store
                    .authorize_session_metadata(&binding)
                    .await
                    .map_err(|_| "Fast setup authority refused")?
            }
        };
        loop {
            let Some(ready) = self
                .prepare_fast(grant, &mut shutdown, &mut heartbeat)
                .await?
            else {
                return Ok(());
            };
            if let Some(companion) = &self.companion {
                if !companion.claim_ready() {
                    return Err(ABANDONED);
                }
            }
            self.wait_window_active(&mut shutdown, &mut heartbeat)
                .await?;
            let Some(input) = self.fast_input(&mut shutdown, &mut heartbeat).await? else {
                return Ok(());
            };
            if let Some(companion) = &self.companion {
                if !companion.claim_start() {
                    return Err(ABANDONED);
                }
            }
            let live = started(
                ready
                    .dispatch(&self.token, &input)
                    .await
                    .map_err(|_| "Fast dispatch refused; reconciliation required")?,
            )?;
            if let Some(companion) = &self.companion {
                companion.started();
            }
            match self.drive_fast(live, &mut shutdown, &mut heartbeat).await? {
                FastExit::Shutdown => return Ok(()),
                FastExit::Stopped { run, proof } => {
                    // ReapedBroker is retained until the exact stopped metadata
                    // issuer has checked the same Fast predecessor and binding,
                    // or shutdown records its proven retirement without a new run.
                    if self
                        .fast_source(&mut shutdown, &mut heartbeat)
                        .await?
                        .is_none()
                    {
                        self.retire_stopped_fast(&run, proof).await?;
                        return Ok(());
                    }
                    let binding = self
                        .store
                        .ensure_role_bindings(&self.owner, &self.config.conversation_id)
                        .await
                        .map_err(|_| "Fast stopped binding unavailable")?
                        .fast;
                    grant = self
                        .store
                        .authorize_stopped_session_metadata(&self.token, &run, &binding)
                        .await
                        .map_err(|_| "Fast stopped-session continuation refused")?;
                    drop(proof);
                }
            }
        }
    }

    async fn retire_stopped_fast(
        &self,
        run: &RunId,
        proof: ReapedBroker,
    ) -> Result<(), &'static str> {
        if self.config.role != config::ExecutionRole::Fast
            || proof.scope().owner() != self.owner.to_string()
            || proof.scope().run() != run.to_string()
            || proof.scope().namespace() != self.config.namespace
        {
            return Err("Fast stopped retirement scope mismatch");
        }
        if let Some(companion) = &self.companion {
            companion.retire();
            return companion.retain(proof);
        }
        if !self.children.wait_empty(Duration::from_secs(2)).await {
            return Err("Fast stopped retirement still owns child resources");
        }
        self.current().await?;
        let result = self
            .store
            .retire_terminal_supervisor(&self.token, run)
            .await
            .map_err(|_| "Fast stopped supervisor retirement refused");
        // Keep the original non-Clone reap witness alive through Core's exact
        // canonical Stopped/current-context transaction. Never reconstruct it
        // from a status, exit code, caller PID, or an acknowledged interrupt.
        drop(proof);
        result
    }

    pub(super) async fn fast_source(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<FastSource>, &'static str> {
        self.fast_source_checked(shutdown, heartbeat, || Ok(()))
            .await
    }

    async fn fast_source_checked(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
        mut check: impl FnMut() -> Result<(), &'static str>,
    ) -> Result<Option<FastSource>, &'static str> {
        loop {
            if *shutdown.borrow() || self.fast_window_due() {
                return Ok(None);
            }
            self.maintain(heartbeat).await?;
            check()?;
            // Zero is intentional: the durable Fast run ledger deduplicates
            // every admitted source, including unknown/failed attempts. A
            // volatile cursor must never skip a held input after release.
            let source = self
                .store
                .next_fast_source(&self.token, &self.config.conversation_id, 0)
                .await;
            let source = match source {
                Ok(source) => source,
                Err(
                    orkestr_v2_application::runtime::RuntimeStoreError::Fenced
                    | orkestr_v2_application::runtime::RuntimeStoreError::Expired,
                ) if self.fast_window_due() => return Ok(None),
                Err(_) => return Err("Fast input eligibility unavailable"),
            };
            // A query racing the shared retirement fence yields no next input.
            // Original terminal/reap checks still decide whether close is legal.
            if let Some(source) = source {
                return Ok(Some(source));
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                _ = shutdown.changed() => return Ok(None),
            }
        }
    }

    pub(super) async fn fast_input(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<FastAdmissionInput>, &'static str> {
        self.fast_input_checked(shutdown, heartbeat, || Ok(()))
            .await
    }

    pub(super) async fn fast_input_checked(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
        check: impl FnMut() -> Result<(), &'static str>,
    ) -> Result<Option<FastAdmissionInput>, &'static str> {
        let Some(source) = self.fast_source_checked(shutdown, heartbeat, check).await? else {
            return Ok(None);
        };
        let binding = self
            .store
            .ensure_role_bindings(&self.owner, &self.config.conversation_id)
            .await
            .map_err(|_| "Fast ready binding unavailable")?
            .fast;
        if binding.state != SessionState::Ready {
            return Err("Fast binding is not ready for another presentation");
        }
        Ok(Some(FastAdmissionInput {
            source_message_id: source.message_id,
            request_key: format!("fast-http:{}", source.event_id),
            source_event_id: source.event_id,
            fast_binding_id: binding.session_id,
            expected_binding_generation: binding.generation,
        }))
    }
}

pub(super) fn started(value: FastStart) -> Result<Box<LiveFast>, &'static str> {
    match value {
        FastStart::Live(live) => Ok(live),
        FastStart::Replay | FastStart::ReconciliationRequired => {
            Err("Fast input already admitted; automatic redispatch refused")
        }
    }
}
