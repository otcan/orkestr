//! Terminal cleanup never claims tasks, starts setup or writes inference.
use super::*;

impl WorkerSchedule {
    /// Close this parent turn's admission. The shared factory ledger stays open
    /// for later parent turns until its separate one-use finalization.
    pub fn quiesce(&mut self) {
        self.quiesced = true;
        if let Some(queue) = &mut self.queue {
            queue.quiesce();
        }
    }

    /// One bounded cleanup step. The caller applies its bounded shutdown wait.
    /// `true` is only a local lifecycle result, never a replacement witness.
    /// Final retirement still requires WorkerReaps::finish with original proofs.
    pub async fn drain(&mut self) -> Result<bool, &'static str> {
        self.quiesce();
        if let Some(mut queue) = self.queue.take() {
            let result = queue.drain().await;
            self.queue = Some(queue);
            return result;
        }
        self.drain_one().await
    }

    pub(super) async fn drain_one(&mut self) -> Result<bool, &'static str> {
        self.quiesce();
        self.poll_one().await?;
        if matches!(self.phase, Phase::Closed(_)) {
            if self.launch.is_some() {
                return Err("Worker closed without original reap evidence");
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub(super) async fn terminal_only(
        &mut self,
        phase: Phase,
    ) -> Result<(Phase, WorkerProgress), &'static str> {
        match phase {
            Phase::Pending if self.launch.is_none() => Ok((
                Phase::Closed(WorkerProgress::Completed),
                WorkerProgress::Completed,
            )),
            // Running checks exact current terminal status or an already-issued
            // control before refusing all further inference in quiesced mode.
            Phase::Running(running) => self.running(running).await,
            _ => Err("Worker setup or nonterminal cleanup requires reconciliation"),
        }
    }

    pub(super) fn accepted(running: Running) -> Result<(Phase, WorkerProgress), &'static str> {
        if running.pump.pending().is_some()
            || running.pump.pending_offline_python().is_some()
            || running
                .tools
                .as_ref()
                .is_some_and(|tools| !tools.renewal_quiescent())
        {
            return Err("Worker accepted with unresolved native effects");
        }
        running.control.disable();
        let broker = running
            .pump
            .retire_broker()
            .map_err(|_| "Worker accepted broker retirement refused")?;
        // The consuming Runtime transition detached this exact child first.
        drop(running.authority);
        Ok((
            Phase::Retiring(Box::new(retirement::Retiring::new(
                broker,
                WorkerProgress::Completed,
            ))),
            WorkerProgress::Running,
        ))
    }
}
