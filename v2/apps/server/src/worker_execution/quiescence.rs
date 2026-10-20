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
            Phase::Pending if self.launch.is_none() => {
                // A claimed task that never started setup ends visibly.
                self.fail_task_setup(None).await;
                Ok((
                    Phase::Closed(WorkerProgress::Completed),
                    WorkerProgress::Completed,
                ))
            }
            Phase::Preparing(preparing) => {
                // The parent left Running during native setup: no delegation
                // can be admitted any more. Record the task failed with its
                // cause and release its unused setup; dropping the setup
                // starts Runtime's owned reaper for the original child.
                let session = preparing.binding.session_id.clone();
                self.fail_task_setup(Some(&session)).await;
                drop(preparing);
                Err("Worker setup ended: parent left Running before delegation")
            }
            // Running checks exact current terminal status or an already-issued
            // control before refusing all further inference in quiesced mode.
            Phase::Running(running) => self.running(running).await,
            _ => Err("Worker setup or nonterminal cleanup requires reconciliation"),
        }
    }

    /// Best effort: Core refuses while the parent still runs, and an already
    /// recorded failure replays. A refusal leaves the task held, as before.
    pub(super) async fn fail_task_setup(&self, setup: Option<&orkestr_v2_contracts::SessionId>) {
        let Some(task) = self.task_id.as_ref() else {
            return;
        };
        if let Err(error) = self
            .store
            .fail_worker_task_setup(&self.credential, task, setup)
            .await
        {
            eprintln!("Worker task setup failure not recorded: {error:?}");
        }
    }

    pub(super) fn retire_proposal(
        running: Running,
        progress: WorkerProgress,
    ) -> Result<(Phase, WorkerProgress), &'static str> {
        if running.pump.pending().is_some()
            || running.pump.pending_offline_python().is_some()
            || running.pump.pending_workspace_exec().is_some()
            || running
                .tools
                .as_ref()
                .is_some_and(|tools| !tools.renewal_quiescent())
            || running
                .workspace_tools
                .as_ref()
                .is_some_and(|tools| !tools.renewal_quiescent())
        {
            return Err("Worker proposal has unresolved native effects");
        }
        running.control.disable();
        let broker = running
            .pump
            .retire_broker()
            .map_err(|_| "Worker proposal broker retirement refused")?;
        // The consuming Runtime transition detached this exact child first.
        // Retain its original wait proof, without accepting the proposal or
        // releasing the durable occupied binding while the owner decides.
        drop(running.authority);
        Ok((
            Phase::Retiring(Box::new(retirement::Retiring::new(broker, progress))),
            WorkerProgress::Running,
        ))
    }
}
