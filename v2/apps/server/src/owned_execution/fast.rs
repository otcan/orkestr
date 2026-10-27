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
    Accepted { run: RunId, proof: ReapedBroker },
    Stopped { run: RunId, proof: ReapedBroker },
}

impl ConfiguredExecution {
    pub(super) async fn run_fast(
        mut self,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), &'static str> {
        self.current().await?;
        let mut heartbeat = Instant::now();
        let grant = if let Some(grant) = self.initial_grant.take() {
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
                        .authorize_bounded_fast_metadata_with_workspace(
                            &self.token,
                            &binding,
                            workspace,
                        )
                        .await
                        .map_err(|_| "Fast window workspace setup authority refused")?,
                    None => self
                        .store
                        .authorize_bounded_fast_metadata(&self.token, &binding)
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
        if self.window.is_some() && self.companion.is_some() {
            // A window's Fast serves each owner input in its own concurrent
            // slot; the canonical lineage below is slot 0.
            return super::fast_pool::run(std::sync::Arc::new(self), grant, shutdown).await;
        }
        self.fast_lineage(grant, shutdown, heartbeat).await
    }

    /// The canonical Fast lineage: one fresh native per presentation, each
    /// replacement issued only after its predecessor's exact terminal truth.
    pub(super) async fn fast_lineage(
        &self,
        mut grant: BoundSessionMetadata,
        mut shutdown: watch::Receiver<bool>,
        mut heartbeat: Instant,
    ) -> Result<(), &'static str> {
        let mut pending =
            super::fast_continuity::PendingFastRetirement::new(self.companion.clone());
        loop {
            let Some(ready) = self
                .prepare_fast(grant, &mut shutdown, &mut heartbeat)
                .await?
            else {
                if let Some((run, proof)) = pending.take() {
                    self.retire_finished_fast(&run, proof).await?;
                }
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
                self.reap_fast_setup(
                    ready
                        .retire_setup()
                        .map_err(|_| "Fast ready setup retirement refused")?,
                    &mut heartbeat,
                )
                .await?;
                if let Some((run, proof)) = pending.take() {
                    self.retire_finished_fast(&run, proof).await?;
                }
                return Ok(());
            };
            if let Some(companion) = &self.companion {
                if !companion.claim_start() {
                    return Err(ABANDONED);
                }
            }
            // The input stays claimed for the window's life: a slot that
            // read it before this admission committed can never take it.
            let live = started(
                ready
                    .dispatch(&self.token, &input)
                    .await
                    .map_err(|_| "Fast dispatch refused; reconciliation required")?,
            )?;
            if let Some(companion) = &self.companion {
                companion.started();
            }
            pending.dispatched();
            match self
                .drive_fast(live, &mut shutdown, &mut heartbeat, false)
                .await?
            {
                FastExit::Shutdown => return Ok(()),
                FastExit::Accepted { run, proof } | FastExit::Stopped { run, proof } => {
                    pending.keep(run.clone(), proof);
                    // ReapedBroker is retained until the terminal metadata
                    // issuer has checked the same Fast predecessor and binding,
                    // or shutdown records its proven retirement without a new run.
                    // The lineage counts as idle while it waits, then claims
                    // and holds the next input across its fresh setup, so no
                    // extra slot sets up a second session for it.
                    if self
                        .fast_source_held(&mut shutdown, &mut heartbeat)
                        .await?
                        .is_none()
                    {
                        let (_, proof) = pending.take().ok_or("Fast terminal witness missing")?;
                        self.retire_finished_fast(&run, proof).await?;
                        return Ok(());
                    }
                    let binding = self
                        .store
                        .ensure_role_bindings(&self.owner, &self.config.conversation_id)
                        .await
                        .map_err(|_| "Fast terminal binding unavailable")?
                        .fast;
                    // The exact original child's non-clone reap witness stays
                    // alive through Core's fresh-binding transaction. A window
                    // Fast never resumes accumulated native history here.
                    grant = if self.window.is_some() {
                        match &self.workspace_grant {
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
                        .map_err(|_| "Fresh Fast continuity refused; reconciliation required")?
                    } else {
                        self.store
                            .authorize_stopped_session_metadata(&self.token, &run, &binding)
                            .await
                            .map_err(|_| "Fast stopped-session continuation refused")?
                    };
                }
            }
        }
    }

    async fn retire_finished_fast(
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
        self.fast_source_checked(shutdown, heartbeat, false, || Ok(()))
            .await
    }

    async fn fast_source_checked(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
        claim: bool,
        mut check: impl FnMut() -> Result<(), &'static str>,
    ) -> Result<Option<FastSource>, &'static str> {
        // A ready lineage waiting here takes the next input itself.
        let _idle = claim.then(|| PrimaryIdle::new(self.companion.as_deref()));
        loop {
            if *shutdown.borrow() || self.fast_window_due() {
                return Ok(None);
            }
            self.maintain(heartbeat).await?;
            check()?;
            let source = self.unclaimed_fast_source(claim).await;
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
                let Some(companion) = self.companion.as_ref().filter(|_| claim) else {
                    return Ok(Some(source));
                };
                if companion.claim_source(&source.event_id)
                    || companion.lineage_holds(&source.event_id)
                {
                    return Ok(Some(source));
                }
                continue;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                _ = shutdown.changed() => return Ok(None),
            }
        }
    }

    /// The lineage's next input, claimed and held for its next presentation.
    async fn fast_source_held(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<FastSource>, &'static str> {
        let source = self
            .fast_source_checked(shutdown, heartbeat, true, || Ok(()))
            .await?;
        if let (Some(source), Some(companion)) = (&source, &self.companion) {
            companion.hold_for_lineage(&source.event_id);
        }
        Ok(source)
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
        let Some(source) = self
            .fast_source_checked(shutdown, heartbeat, true, check)
            .await?
        else {
            return Ok(None);
        };
        if let Some(companion) = &self.companion {
            // Presenting it now: the hold ends, the claim stays.
            companion.take_lineage_hold(&source.event_id);
        }
        let binding = match self
            .store
            .ensure_role_bindings(&self.owner, &self.config.conversation_id)
            .await
        {
            Ok(bindings) if bindings.fast.state == SessionState::Ready => Ok(bindings.fast),
            Ok(_) => Err("Fast binding is not ready for another presentation"),
            Err(_) => Err("Fast ready binding unavailable"),
        };
        let binding = binding.inspect_err(|_| {
            if let Some(companion) = &self.companion {
                companion.release_source(&source.event_id);
            }
        })?;
        Ok(Some(FastAdmissionInput {
            source_message_id: source.message_id,
            request_key: format!("fast-http:{}", source.event_id),
            source_event_id: source.event_id,
            fast_binding_id: binding.session_id,
            expected_binding_generation: binding.generation,
        }))
    }
}

impl ConfiguredExecution {
    /// Earliest admissible owner input no Fast task of this window claimed.
    /// Zero is intentional: the durable Fast run ledger deduplicates every
    /// admitted source, including unknown/failed attempts. A volatile cursor
    /// must never skip a held input after release; only claimed inputs (at
    /// most one per live slot) are stepped over.
    /// `lineage`: the canonical lineage also sees the input it holds across
    /// its own rotation; an extra slot never does.
    pub(super) async fn unclaimed_fast_source(
        &self,
        lineage: bool,
    ) -> Result<Option<FastSource>, orkestr_v2_application::runtime::RuntimeStoreError> {
        let mut after = 0;
        loop {
            let source = self
                .store
                .next_fast_source(&self.token, &self.config.conversation_id, after)
                .await?;
            match (source, &self.companion) {
                (Some(source), Some(companion))
                    if companion.is_claimed(&source.event_id)
                        && !(lineage && companion.lineage_holds(&source.event_id)) =>
                {
                    after = source.sequence;
                }
                (source, _) => return Ok(source),
            }
        }
    }
}

/// Marks the canonical lineage idle (ready, waiting for input) while held.
struct PrimaryIdle<'a>(Option<&'a super::window_roles::Companion>);
impl<'a> PrimaryIdle<'a> {
    fn new(companion: Option<&'a super::window_roles::Companion>) -> Self {
        if let Some(companion) = companion {
            companion.set_primary_idle(true);
        }
        Self(companion)
    }
}
impl Drop for PrimaryIdle<'_> {
    fn drop(&mut self) {
        if let Some(companion) = self.0 {
            companion.set_primary_idle(false);
        }
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
