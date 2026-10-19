//! Parent-owned bounded dispatch of explicit owner tasks, never provider prose.
use super::*;
use orkestr_v2_contracts::ExecutionPhase;

const MAX_ACTIVE: usize = 4;
pub(super) struct TaskQueue {
    children: Vec<WorkerSchedule>,
    registration: Option<crate::worker_tasks::Registration>,
    closed: bool,
}
impl TaskQueue {
    pub(super) fn new(registration: crate::worker_tasks::Registration) -> Self {
        Self {
            children: Vec::new(),
            registration: Some(registration),
            closed: false,
        }
    }
    pub(super) async fn poll(
        &mut self,
        parent: &WorkerSchedule,
    ) -> Result<WorkerProgress, &'static str> {
        if self.closed {
            return Ok(WorkerProgress::Unknown);
        }
        let status = parent
            .store
            .execution_run_status(
                &parent.credential,
                &parent.parent.owner_id,
                &parent.parent.conversation_id,
                &parent.parent.run_id,
            )
            .await
            .map_err(|_| "Worker task parent unavailable")?
            .filter(|status| status.run_id.as_ref() == Some(&parent.parent.run_id))
            .ok_or("Worker task parent scope changed")?;
        if status.phase == ExecutionPhase::Starting && Instant::now() < parent.deadline {
            return Ok(WorkerProgress::WaitingForParent);
        }
        if status.phase != ExecutionPhase::Running {
            self.children.clear();
            self.registration.take();
            self.closed = true;
            return Ok(WorkerProgress::Unknown);
        }
        let mut active = Vec::with_capacity(MAX_ACTIVE);
        for mut child in self.children.drain(..) {
            match child.poll_one().await {
                Ok(_) if !matches!(child.phase, Phase::Closed(_)) => active.push(child),
                Ok(_) => {}
                Err(reason) => eprintln!("owned Worker subtask requires reconciliation: {reason}"),
            }
        }
        self.children = active;
        // At most one fresh claim per parent tick. Reserve actual child capacity
        // before consuming the claim; reapers retain permits until actual wait.
        if self.children.len() < MAX_ACTIVE {
            if let Ok(slot) = capacity().clone().try_acquire_owned() {
                if let Some(claim) = parent
                    .store
                    .claim_worker_task(&parent.credential, &parent.parent.run_id)
                    .await
                    .map_err(|_| "Worker task claim refused")?
                {
                    let child = WorkerSchedule::from_task(parent, claim, slot)?;
                    self.children.push(child);
                }
            }
        }
        Ok(if self.children.is_empty() {
            WorkerProgress::WaitingForTask
        } else {
            WorkerProgress::Running
        })
    }
}
impl WorkerSchedule {
    fn from_task(
        parent: &Self,
        claim: WorkerTaskClaim,
        slot: OwnedSemaphorePermit,
    ) -> Result<Self, &'static str> {
        let run = claim.parent();
        if run.role != SessionRole::Deep
            || run.owner_id != parent.parent.owner_id
            || run.conversation_id != parent.parent.conversation_id
            || run.run_id != parent.parent.run_id
            || run.session_id != parent.parent.session_id
            || run.native_session_id != parent.parent.native_session_id
            || claim.source_message_id() != &parent.message
            || claim.source_event_id() != &parent.source_event
            || claim.lifetime_ms() > parent.configuration.policy.lifetime_ms()
        {
            return Err("Worker task captured parent scope mismatch");
        }
        Ok(Self {
            phase: Phase::Pending,
            store: parent.store.clone(),
            credential: parent.credential.clone(),
            configuration: parent.configuration.clone(),
            parent: run.clone(),
            message: claim.source_message_id().clone(),
            source_event: claim.source_event_id().clone(),
            key: format!("worker-task:{}", claim.task_id()),
            deadline: Instant::now() + Duration::from_secs(15),
            lifetime_ms: claim.lifetime_ms(),
            task_claim: Some(claim),
            queue: None,
            slot: Some(slot),
        })
    }
}
