//! Owner task intent and immutable request retry. Claims are not live executors.
use orkestr_v2_contracts::{
    ConversationId, RunId, TaskId, WorkerTaskCreateRequest, WorkerTaskList, WorkerTaskPhase,
    WorkerTaskReceipt,
};
use std::collections::BTreeSet;

#[derive(Clone)]
pub struct PendingTask {
    pub conversation: ConversationId,
    pub request: WorkerTaskCreateRequest,
    draft_revision: u64,
}
#[derive(Clone, Default)]
pub struct TaskDraft {
    pub title: String,
    pub instructions: String,
    time_limit: crate::worker_time_limit::TimeLimit,
    revision: u64,
    pending: Option<PendingTask>,
    conflict: bool,
    confirmed: bool,
    notice: Option<&'static str>,
}
impl TaskDraft {
    pub fn time_limit(&self) -> crate::worker_time_limit::TimeLimit {
        self.time_limit
    }
    pub fn set_time_limit(&mut self, value: &str) -> Result<(), &'static str> {
        let selected = crate::worker_time_limit::TimeLimit::parse(value)
            .ok_or("Choose a listed time limit.")?;
        if selected != self.time_limit {
            self.time_limit = selected;
            self.revision = self
                .revision
                .checked_add(1)
                .expect("task draft revision exhausted");
        }
        Ok(())
    }
    pub fn pending_budget_ms(&self) -> Option<Option<u32>> {
        self.pending.as_ref().map(|p| p.request.execution_budget_ms)
    }

    pub fn edit(&mut self, title: String, instructions: String) {
        self.title = title;
        self.instructions = instructions;
        self.revision = self
            .revision
            .checked_add(1)
            .expect("task draft revision exhausted");
    }
    pub fn prepare(
        &mut self,
        conversation: ConversationId,
        parent: RunId,
        control_revision: i64,
        can_create: bool,
        key: String,
    ) -> Result<PendingTask, &'static str> {
        if let Some(pending) = &self.pending {
            if pending.conversation != conversation || pending.request.parent_run_id != parent {
                return Err("Task belongs to another parent.");
            }
            if self.conflict {
                return Err("Review the current parent before creating a new request.");
            }
            if self.confirmed {
                return Err("Task creation already confirmed.");
            }
            return Ok(pending.clone());
        }
        if !can_create {
            return Err("Task creation is unavailable for this parent.");
        }
        let request = WorkerTaskCreateRequest {
            parent_run_id: parent,
            expected_control_revision: control_revision,
            request_key: key,
            title: self.title.clone(),
            instructions: self.instructions.clone(),
            lifetime_ms: 30_000,
            execution_budget_ms: self.time_limit.budget_ms(),
        };
        if !request.is_valid() {
            return Err(
                "Enter a title up to 160 bytes and independent instructions up to 16384 bytes.",
            );
        }
        let pending = PendingTask {
            conversation,
            request,
            draft_revision: self.revision,
        };
        self.pending = Some(pending.clone());
        self.notice = Some("Creating task…");
        Ok(pending)
    }
    fn matches(&self, pending: &PendingTask) -> bool {
        self.pending.as_ref().is_some_and(|p| {
            p.conversation == pending.conversation
                && serde_json::to_value(&p.request).ok()
                    == serde_json::to_value(&pending.request).ok()
        })
    }
    pub fn receipt(
        &mut self,
        pending: &PendingTask,
        receipt: WorkerTaskReceipt,
    ) -> Result<(), &'static str> {
        if !self.matches(pending)
            || !receipt.is_valid()
            || receipt.conversation_id != pending.conversation
            || receipt.parent_run_id != pending.request.parent_run_id
        {
            return Err("Task receipt does not match the selected parent.");
        }
        if !self.confirmed && self.revision == pending.draft_revision {
            self.title.clear();
            self.instructions.clear();
            self.time_limit = Default::default();
        }
        self.confirmed = true;
        self.notice = Some("Task saved. Queued or claimed intent is not proof of running work.");
        Ok(())
    }
    pub fn failed(&mut self, pending: &PendingTask, status: u16) {
        if !self.matches(pending) {
            return;
        }
        self.conflict = status == 409;
        self.notice = Some(match status { 409 => "Task refused: parent state changed or task capacity reached. Review before another request.", 401 | 403 => "Task request refused. Sign in again.", _ => "Task receipt unknown. Retry uses the original instructions and request key." });
    }
    pub fn review(&mut self) {
        if self.conflict || self.confirmed {
            self.pending = None;
            self.conflict = false;
            self.confirmed = false;
            self.notice = None;
        }
    }
    pub fn needs_review(&self) -> bool {
        self.conflict || self.confirmed
    }
    pub fn retryable(&self) -> bool {
        self.pending.is_some() && !self.conflict && !self.confirmed
    }
    pub fn notice(&self) -> Option<&'static str> {
        self.notice
    }
}
#[derive(Clone, Default)]
pub struct TaskHistory {
    list: Option<WorkerTaskList>,
    removed: BTreeSet<String>,
}
impl TaskHistory {
    pub fn apply(
        &mut self,
        conversation: &ConversationId,
        parent: &RunId,
        mut list: WorkerTaskList,
    ) -> Result<(), &'static str> {
        if !list.is_valid()
            || &list.conversation_id != conversation
            || &list.parent_run_id != parent
        {
            return Err("Worker task scope mismatch");
        }
        for task in &mut list.tasks {
            if self.removed.contains(&task.task.task_id.to_string()) {
                task.title = None;
                task.instructions_available = false;
            }
        }
        self.list = Some(list);
        Ok(())
    }
    pub fn removed(&mut self, task: &TaskId) {
        self.removed.insert(task.to_string());
        if let Some(list) = &mut self.list {
            for row in &mut list.tasks {
                if row.task.task_id == *task {
                    row.title = None;
                    row.instructions_available = false;
                }
            }
        }
    }
    pub fn list(&self) -> Option<&WorkerTaskList> {
        self.list.as_ref()
    }
}
/// The phase, or for a task that never ran, its recorded cause.
pub fn status_label(row: &orkestr_v2_contracts::WorkerTaskStatus) -> &'static str {
    match row.failure_cause {
        Some(orkestr_v2_contracts::WorkerTaskFailureCause::ParentLeftRunningDuringSetup) => {
            "Not started: the parent finished while the Worker was still setting up"
        }
        None => phase_label(row.phase),
    }
}
pub fn phase_label(phase: WorkerTaskPhase) -> &'static str {
    match phase {
        WorkerTaskPhase::Queued => "Queued intent",
        WorkerTaskPhase::Claimed => "Issued intent; execution not confirmed",
        WorkerTaskPhase::Preparing => "Preparing worker",
        WorkerTaskPhase::Running => "Worker running",
        WorkerTaskPhase::AwaitingAcceptance => "Awaiting owner acceptance",
        WorkerTaskPhase::Completed => "Completed after owner acceptance",
        WorkerTaskPhase::CancelRequested => "Stop requested; interruption unconfirmed",
        WorkerTaskPhase::Cancelled => "Worker cancellation confirmed",
        WorkerTaskPhase::Failed => "Worker failed",
        WorkerTaskPhase::Held => "Task held; no automatic replay",
    }
}
