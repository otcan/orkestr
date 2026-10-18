//! Ordinary Core admission and Runtime transport; no substitute execution grant.
use super::*;
use orkestr_v2_application::runtime::{
    AdmissionDisposition, DispatchClaimResult, RuntimeStore, SessionState,
};
use orkestr_v2_contracts::ExecutionPhase;
use orkestr_v2_store_sqlite::{ExecutionConsumption, WorkerAdmissionInput, WorkerDelegationResult};

impl WorkerSchedule {
    pub(super) async fn advance(
        &mut self,
        phase: Phase,
    ) -> Result<(Phase, WorkerProgress), &'static str> {
        if let Phase::Closed(progress) = phase {
            return Ok((Phase::Closed(progress), progress));
        }
        if let Phase::Stopping(control) = phase {
            return Ok(Self::stopping(control).await);
        }
        let parent = self
            .store
            .execution_run_status(
                &self.credential,
                &self.parent.owner_id,
                &self.parent.conversation_id,
                &self.parent.run_id,
            )
            .await
            .map_err(|_| "Worker parent status unavailable")?
            .ok_or("Worker parent status missing")?;
        if parent.run_id.as_ref() != Some(&self.parent.run_id) {
            return Err("Worker parent scope changed");
        }
        if parent.phase != ExecutionPhase::Running {
            if matches!(phase, Phase::Pending)
                && parent.phase == ExecutionPhase::Starting
                && Instant::now() < self.deadline
            {
                return Ok((phase, WorkerProgress::WaitingForParent));
            }
            // Core's parent terminal transition fences descendants atomically.
            // Owned local cleanup cannot fabricate a successful child Stop.
            return Ok((
                Phase::Closed(WorkerProgress::Unknown),
                WorkerProgress::Unknown,
            ));
        }
        match phase {
            Phase::Pending => self.begin().await,
            Phase::Preparing(preparing) => {
                let Preparing { mut setup, binding } = *preparing;
                if Instant::now() >= self.deadline {
                    return Err("Worker native setup deadline exceeded");
                }
                if !setup.poll().map_err(|_| "Worker native setup refused")? {
                    return Ok((
                        Phase::Preparing(Box::new(Preparing { setup, binding })),
                        WorkerProgress::Preparing,
                    ));
                }
                let ready = setup
                    .confirm()
                    .await
                    .map_err(|_| "Worker native readiness refused")?;
                self.dispatch(ready, binding).await
            }
            Phase::Running(running) => self.running(running).await,
            Phase::Stopping(_) => unreachable!(),
            Phase::Closed(_) => unreachable!(),
        }
    }

    async fn begin(&mut self) -> Result<(Phase, WorkerProgress), &'static str> {
        let slot = match self.slot.take() {
            Some(slot) => slot,
            None => capacity()
                .clone()
                .try_acquire_owned()
                .map_err(|_| "Worker concurrency limit reached")?,
        };
        self.configuration.verify_launcher()?;
        let directory = directory::Directory::create(&self.configuration.directory)?;
        let directories = directory.child(&self.configuration.workspace)?;
        let binding = self
            .store
            .create_worker_binding(
                &self.parent.owner_id,
                &self.parent.conversation_id,
                Some(&self.parent.session_id),
                &self.key,
            )
            .await
            .map_err(|_| "Worker binding unavailable")?;
        if binding.role != SessionRole::Worker
            || binding.state != SessionState::Starting
            || binding.parent_session_id.as_ref() != Some(&self.parent.session_id)
        {
            return Err("Worker binding requires reconciliation");
        }
        let grant = self
            .store
            .authorize_worker_metadata(&self.credential, &self.parent.run_id, &binding)
            .await
            .map_err(|_| "Worker metadata authority refused")?;
        let open = if self.configuration.offline_python.is_some() {
            PreparingCodex::open_worker_offline_python_retained
        } else {
            PreparingCodex::open_retained
        };
        let setup = open(
            self.store.clone(),
            grant,
            &self.configuration.launcher,
            &self.configuration.workspace,
            directories,
            Box::new((directory, slot, self.configuration.children.retain())),
        )
        .map_err(|_| "Worker native launch refused")?;
        self.deadline = Instant::now() + Duration::from_secs(15);
        Ok((
            Phase::Preparing(Box::new(Preparing { setup, binding })),
            WorkerProgress::Preparing,
        ))
    }

    async fn dispatch(
        &mut self,
        ready: orkestr_runtime::execution::ReadyCodex,
        original: Binding,
    ) -> Result<(Phase, WorkerProgress), &'static str> {
        let binding = self
            .store
            .create_worker_binding(
                &self.parent.owner_id,
                &self.parent.conversation_id,
                Some(&self.parent.session_id),
                &self.key,
            )
            .await
            .map_err(|_| "Worker confirmed binding unavailable")?;
        if binding.session_id != original.session_id
            || binding.role != SessionRole::Worker
            || binding.state != SessionState::Ready
            || binding.parent_session_id.as_ref() != Some(&self.parent.session_id)
        {
            return Err("Worker readiness lineage changed");
        }
        let delegation = if let Some(claim) = self.task_claim.take() {
            self.store
                .delegate_worker_task(&self.credential, claim, &binding)
                .await
                .map_err(|_| "Worker subtask delegation refused")?
        } else {
            if self.configuration.policy.owner_tasks() {
                return Err("Worker subtask claim missing; parent input substitution refused");
            }
            let input = WorkerAdmissionInput {
                worker_binding_id: binding.session_id.clone(),
                expected_binding_generation: binding.generation,
                source_message_id: self.message.clone(),
                source_event_id: self.source_event.clone(),
                request_key: self.key.clone(),
                lifetime_ms: self.lifetime_ms,
            };
            let WorkerDelegationResult::Fresh(delegation) = self
                .store
                .delegate_worker(&self.credential, &self.parent.run_id, &input)
                .await
                .map_err(|_| "Worker delegation refused")?
            else {
                return Err("Worker delegation already exists; automatic replay refused");
            };
            delegation
        };
        let admitted = self
            .store
            .admit_worker(&self.credential, delegation)
            .await
            .map_err(|_| "Worker admission refused")?;
        if admitted.disposition != AdmissionDisposition::FreshCandidate {
            return Err("Worker admission requires reconciliation");
        }
        let DispatchClaimResult::Reserved(reservation) = self
            .store
            .claim_provider_dispatch(&admitted, &self.key)
            .await
            .map_err(|_| "Worker reservation refused")?
        else {
            return Err("Worker reservation requires reconciliation");
        };
        let ExecutionConsumption::Dispatch(capability) = self
            .store
            .consume_execution(&reservation)
            .await
            .map_err(|_| "Worker consumption refused")?
        else {
            return Err("Worker delivery is unknown; automatic replay refused");
        };
        if capability.provider().run.role != SessionRole::Worker
            || capability.provider().binding != binding
        {
            return Err("Worker consumed identity mismatch");
        }
        let run = capability.provider().run.run_id.clone();
        let tools = match &self.configuration.offline_python {
            Some(dispatcher) => Some(
                tools::WorkerTools::prepare(
                    self.store.clone(),
                    self.credential.clone(),
                    &capability,
                    dispatcher.clone(),
                    self.configuration.children.clone(),
                )
                .await?,
            ),
            None => None,
        };
        let (authority, pump) = ready
            .attach(self.store.clone(), capability)
            .map_err(|_| "Worker attachment is uncertain; automatic replay refused")?;
        let (control, controls) = self
            .configuration
            .controls
            .register(self.store.clone(), &run)
            .map_err(|_| "Worker control registration refused")?;
        // Attempt native interruption before the hard lease expires. Core's
        // clipped authoritative deadline may be earlier; refusal stays unknown.
        self.deadline = Instant::now()
            + Duration::from_millis(self.lifetime_ms.into())
                .saturating_sub(Duration::from_millis(250));
        Ok((
            Phase::Running(Box::new(Running {
                authority,
                pump,
                run,
                control,
                controls,
                tools,
            })),
            WorkerProgress::Running,
        ))
    }
}
