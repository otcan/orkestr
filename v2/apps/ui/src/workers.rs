//! Bounded authenticated Worker discovery state. A locator never grants control.
use orkestr_v2_contracts::{ConversationId, RunId, WorkerExecutionPage, WorkerRecoveryDisposition};
#[derive(Clone)]
pub struct WorkerRead {
    generation: u64,
    conversation: ConversationId,
    after: Option<RunId>,
}
#[derive(Clone, Default)]
pub struct Workers {
    generation: u64,
    read: Option<WorkerRead>,
    page: Option<WorkerExecutionPage>,
    received_ms: Option<u64>,
    selected: Option<RunId>,
    loading: bool,
    unavailable: bool,
}
impl Workers {
    pub fn begin(&mut self, conversation: ConversationId, after: Option<RunId>) -> WorkerRead {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("worker read generation exhausted");
        if self
            .page
            .as_ref()
            .is_some_and(|p| p.conversation_id != conversation)
        {
            self.page = None;
            self.received_ms = None;
            self.selected = None;
        }
        let read = WorkerRead {
            generation: self.generation,
            conversation,
            after,
        };
        self.selected = None;
        self.read = Some(read.clone());
        self.loading = true;
        self.unavailable = false;
        read
    }
    fn current(&self, read: &WorkerRead) -> bool {
        self.read.as_ref().is_some_and(|r| {
            r.generation == read.generation
                && r.conversation == read.conversation
                && r.after == read.after
        })
    }
    pub fn apply(
        &mut self,
        read: &WorkerRead,
        now: u64,
        page: WorkerExecutionPage,
    ) -> Result<(), &'static str> {
        if !self.current(read)
            || !page.is_valid()
            || page.conversation_id != read.conversation
            || read.after.as_ref().is_some_and(|after| {
                page.workers
                    .iter()
                    .any(|w| w.run_id.to_string() <= after.to_string())
            })
            || self.received_ms.is_some_and(|last| now < last)
            || self.page.as_ref().is_some_and(|old| {
                page.revision < old.revision
                    || (page.revision == old.revision && page.observed_at_ms < old.observed_at_ms)
            })
        {
            return Err("Worker status unavailable");
        }
        // Each response is a fresh bounded page, never an inferred stable export.
        self.selected = self
            .selected
            .take()
            .filter(|run| page.workers.iter().any(|w| &w.run_id == run));
        if self.page.as_ref() != Some(&page) {
            self.received_ms = Some(now);
        }
        self.page = Some(page);
        self.loading = false;
        self.unavailable = false;
        Ok(())
    }
    pub fn failed(&mut self, read: &WorkerRead) {
        if self.current(read) {
            self.loading = false;
            self.unavailable = true;
        }
    }
    pub fn clear_owner(&mut self) {
        let generation = self
            .generation
            .checked_add(1)
            .expect("worker owner generation exhausted");
        *self = Self {
            generation,
            ..Self::default()
        };
    }
    pub fn page(&self) -> Option<&WorkerExecutionPage> {
        self.page.as_ref()
    }
    pub fn displayed_page(&self) -> Option<&WorkerExecutionPage> {
        if self.loading {
            None
        } else {
            self.page.as_ref()
        }
    }
    pub fn select(&mut self, run: &RunId) -> bool {
        if self
            .displayed_page()
            .is_some_and(|p| p.workers.iter().any(|w| &w.run_id == run))
        {
            self.selected = Some(run.clone());
            true
        } else {
            false
        }
    }
    pub fn selected(&self) -> Option<&RunId> {
        self.selected.as_ref()
    }
    pub fn notice(&self, now: u64) -> &'static str {
        if self.loading {
            "Loading workers…"
        } else if self.unavailable {
            "Workers unavailable. Refresh to retry."
        } else if self
            .received_ms
            .is_none_or(|time| now < time || now - time > 15000)
        {
            "Worker status stale. Refresh to check current activity."
        } else if self.page.as_ref().is_some_and(|p| p.workers.is_empty()) {
            "No workers found."
        } else {
            "Worker activity"
        }
    }
}
pub fn recovery_label(recovery: WorkerRecoveryDisposition) -> &'static str {
    match recovery {
        WorkerRecoveryDisposition::CurrentIncarnation => {
            "Current session; recovery availability unconfirmed"
        }
        WorkerRecoveryDisposition::ReconciliationRequired => {
            "Reconciliation required; automatic resume unavailable"
        }
    }
}
