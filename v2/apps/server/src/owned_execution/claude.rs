//! Selected Claude turn through the ordinary server. Setup ACK is only
//! protocol readiness; Runtime/Core persist matching native init before Started.
use super::*;
use crate::claude_execution::{PreparingClaudeExecution, ReadyClaudeExecution};
use orkestr_runtime::containment::ChildDirectories;
use orkestr_v2_application::runtime::{RuntimeStore, RuntimeStoreError};
use orkestr_v2_contracts::ExecutionPhase;
use std::time::Instant;

impl ConfiguredExecution {
    pub(super) async fn drive_claude(
        &self,
        ready: ReadyClaudeExecution,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<
        Option<(
            orkestr_v2_contracts::RunId,
            orkestr_runtime::containment::ReapedBroker,
        )>,
        &'static str,
    > {
        // Uses the same current-owner claim/admit/reserve/one-use consumption
        // path as Codex. Provider/account selectors never come from HTTP input.
        let Some(capability) = self.next(shutdown, heartbeat).await? else {
            return Ok(None);
        };
        let run = capability.provider().run.run_id.clone();
        let mut live = ready
            .attach(capability)
            .map_err(|_| "Claude attachment uncertain; automatic replay refused")?;
        let mut budget = self.config.execution_budget.start(Instant::now());
        loop {
            self.maintain(heartbeat).await?;
            let status = self
                .store
                .execution_status(&self.owner, &self.config.conversation_id)
                .await
                .map_err(|_| "Claude status unavailable")?
                .ok_or("Claude status missing")?;
            if status.run_id.as_ref() != Some(&run) {
                return Err("Claude scope changed; reconciliation required");
            }
            match status.phase {
                ExecutionPhase::Completed => {
                    // Consume the exact completed pump before opening a new
                    // child. Neither a projection nor local exit proves reap.
                    let retiring = live
                        .retire_completed()
                        .map_err(|_| "Claude accepted-session retirement refused")?;
                    let proof = self.reaped(retiring, &run, heartbeat).await?;
                    return Ok(Some((run, proof)));
                }
                ExecutionPhase::AwaitingAcceptance => {
                    // Preserve the proposal and child while the owner decides;
                    // never read late provider frames or claim a queued input.
                    if *shutdown.borrow() {
                        return Ok(None);
                    }
                }
                ExecutionPhase::Failed
                | ExecutionPhase::Blocked
                | ExecutionPhase::Cancelled
                | ExecutionPhase::CancelRequested => {
                    return Err("Claude execution requires reconciliation");
                }
                ExecutionPhase::Starting | ExecutionPhase::Running => {
                    let cancellation = if *shutdown.borrow() {
                        Some("isolated-runtime-shutdown")
                    } else {
                        budget.cancellation_key(Instant::now())
                    };
                    if let Some(key) = cancellation {
                        // Durable fence precedes local cleanup. There is no
                        // native Stop port yet: CancelRequested stays unknown.
                        self.store
                            .request_cancel(&self.owner, &run, key)
                            .await
                            .map_err(|_| "Claude shutdown fence requires reconciliation")?;
                        return Err("Claude interruption remains unconfirmed");
                    }
                    match live.tick().await {
                        Ok(true) => budget.observed(Instant::now()),
                        Ok(false)
                        | Err(orkestr_runtime::supervisor::Error::Store(
                            RuntimeStoreError::Busy | RuntimeStoreError::Unavailable,
                        )) => {}
                        Err(_) => {
                            return Err("Claude observation refused; reconciliation required")
                        }
                    }
                }
                ExecutionPhase::Queued => return Err("Claude admitted run unexpectedly queued"),
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => {},
            }
        }
        // LiveClaudeExecution Drop fences and transfers the owned child to the
        // reaper. ChildSet remains retained until actual wait; no fake Stopped.
    }

    pub(super) async fn prepare_claude(
        &self,
        grant: BoundSessionMetadata,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<ReadyClaudeExecution>, &'static str> {
        self.maintain(heartbeat).await?;
        self.config.verify_launcher()?;
        if *shutdown.borrow() {
            return Ok(None);
        }
        let directories = ChildDirectories::new(
            &self.config.workspace,
            &self.directory.join("home"),
            &self.directory.join("tmp"),
        )
        .map_err(|_| "Claude child directories unavailable")?;
        let mut setup = PreparingClaudeExecution::open_retained(
            self.store.clone(),
            grant,
            &self.config.launcher,
            directories,
            self.children.retain(),
        )
        .map_err(|_| "Claude broker setup refused")?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if *shutdown.borrow() {
                return Ok(None);
            }
            self.maintain(heartbeat).await?;
            if setup
                .poll_ready()
                .map_err(|_| "Claude protocol initialization refused")?
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err("Claude protocol initialization timed out");
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => return Ok(None),
            }
        }
        setup
            .confirm()
            .await
            .map(Some)
            .map_err(|_| "Claude protocol readiness commit refused")
    }
}
