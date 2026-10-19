//! Read-only Stop holds. Neither discovery nor fresh input authorizes release.
use orkestr_v2_contracts::{ConversationId, HeldInputReason, HeldOwnerInput, HeldOwnerInputPage};

pub const RESUME_UNAVAILABLE: &str =
    "Resume unavailable: releasing held input is not supported yet.";
pub const CANCEL_UNAVAILABLE: &str =
    "Cancel unavailable: cancelling held input is not supported yet. The input remains saved.";

#[derive(Clone)]
pub struct HeldRead {
    generation: u64,
    conversation: ConversationId,
    after_sequence: i64,
}
#[derive(Clone, Default)]
pub struct HeldInputs {
    generation: u64,
    read: Option<HeldRead>,
    page: Option<HeldOwnerInputPage>,
    received_ms: Option<u64>,
    loading: bool,
    failed: bool,
}
impl HeldInputs {
    pub fn begin(&mut self, conversation: ConversationId, after_sequence: i64) -> HeldRead {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("held input generation exhausted");
        if self
            .page
            .as_ref()
            .is_some_and(|page| page.conversation_id != conversation)
        {
            self.page = None;
            self.received_ms = None;
        }
        let read = HeldRead {
            generation: self.generation,
            conversation,
            after_sequence,
        };
        self.read = Some(read.clone());
        self.loading = true;
        self.failed = false;
        read
    }
    fn current(&self, read: &HeldRead) -> bool {
        self.read.as_ref().is_some_and(|current| {
            current.generation == read.generation
                && current.conversation == read.conversation
                && current.after_sequence == read.after_sequence
        })
    }
    pub fn apply(
        &mut self,
        read: &HeldRead,
        now: u64,
        page: HeldOwnerInputPage,
    ) -> Result<(), &'static str> {
        if !self.current(read)
            || read.after_sequence < 0
            || !page.is_valid()
            || page.conversation_id != read.conversation
            || page
                .held
                .iter()
                .any(|input| input.scope_sequence <= read.after_sequence)
            || self.received_ms.is_some_and(|time| now < time)
            || self.page.as_ref().is_some_and(|old| {
                page.revision < old.revision
                    || (page.revision == old.revision && page.observed_at_ms < old.observed_at_ms)
            })
        {
            return Err("Held input status unavailable");
        }
        if self.page.as_ref() != Some(&page) {
            self.received_ms = Some(now);
        }
        self.page = Some(page);
        self.loading = false;
        self.failed = false;
        Ok(())
    }
    pub fn failed(&mut self, read: &HeldRead) {
        if self.current(read) {
            self.loading = false;
            self.failed = true;
        }
    }
    pub fn clear_owner(&mut self) {
        let generation = self
            .generation
            .checked_add(1)
            .expect("held owner generation exhausted");
        *self = Self {
            generation,
            ..Self::default()
        };
    }
    pub fn displayed_page(&self) -> Option<&HeldOwnerInputPage> {
        if self.loading {
            None
        } else {
            self.page.as_ref()
        }
    }
    pub fn status(&self, now: u64) -> &'static str {
        if self.loading {
            "Loading held input…"
        } else if self.failed {
            "Held input unavailable. Saved input has not been released."
        } else if self.page.is_none() {
            "Held input cannot be checked on this connection yet."
        } else if self
            .received_ms
            .is_none_or(|time| now < time || now - time > 15000)
        {
            "Held input status is stale. No input has been released."
        } else if self.page.as_ref().is_some_and(|page| page.held.is_empty()) {
            "No held input in this page."
        } else {
            "Older input remains held after Stop."
        }
    }
}
pub fn reason(input: &HeldOwnerInput) -> &'static str {
    match input.reason {
        HeldInputReason::StopBoundary => "Held by Stop; not automatically replayed",
    }
}
pub fn fresh_input_notice(page: &HeldOwnerInputPage) -> &'static str {
    if page.eligible_input_available {
        "New input is queued separately. It can start only after cleanup and readiness checks; older held input stays held."
    } else {
        "A new message does not release older held input. Starting new work still requires cleanup and readiness checks."
    }
}
