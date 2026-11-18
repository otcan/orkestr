//! One assistant answer keeps one place in the chat. While a run writes, the
//! chat shows its newest text; the accepted reply takes over only once it can
//! show its own text. Without this every update and the final handover removed
//! the bubble and drew it again from nothing.
use orkestr_v2_contracts::{ExecutionPhase, ExecutionStatus, RunId};
use std::collections::BTreeSet;

/// Whether an assistant message is the run's answer or an interim update
/// (owner request 2026-11-18: the chat must say which). An accepted reply is
/// the run's final answer; the live bubble of a run still working is an
/// update, replaced in place by the next update and then by the answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageKind {
    Update,
    Final,
    Stopped,
    Unfinished,
}

impl MessageKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Update => "Update",
            Self::Final => "Final",
            Self::Stopped => "Stopped",
            Self::Unfinished => "Not finished",
        }
    }
    pub fn slug(self) -> &'static str {
        match self {
            Self::Update => "update",
            Self::Final => "final",
            Self::Stopped => "stopped",
            Self::Unfinished => "unfinished",
        }
    }
}

/// The kind of the live bubble of a run in `phase`.
pub fn live_kind(phase: ExecutionPhase) -> MessageKind {
    use ExecutionPhase::*;
    match phase {
        Queued | Starting | Running | CancelRequested => MessageKind::Update,
        AwaitingAcceptance | Completed => MessageKind::Final,
        Cancelled => MessageKind::Stopped,
        Failed | Blocked => MessageKind::Unfinished,
    }
}

/// The line under a live update while its run still works: the update is
/// not the answer, more is coming.
pub fn working_line(phase: ExecutionPhase) -> Option<&'static str> {
    use ExecutionPhase::*;
    match phase {
        Queued | Starting | Running => Some("Still working…"),
        CancelRequested => Some("Stopping…"),
        AwaitingAcceptance | Completed | Cancelled | Failed | Blocked => None,
    }
}

/// The kind a V1 history message reports by its phase: `commentary` is a
/// progress note, `final_answer` the answer. Owner messages have none.
pub fn v1_kind(phase: Option<&str>) -> Option<MessageKind> {
    match phase? {
        "commentary" => Some(MessageKind::Update),
        "final_answer" => Some(MessageKind::Final),
        _ => None,
    }
}

/// The newest text of a run that has reached the screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shown {
    pub run: RunId,
    pub text: String,
}

/// The unfinished answers the chat draws below its settled messages.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LiveRows {
    /// A run that already ended, until its accepted reply is ready.
    pub finishing: Option<Shown>,
    /// The run whose newest payload the chat follows.
    pub writing: Option<ExecutionStatus>,
}

impl LiveRows {
    /// Whether a live row still stands in for the accepted reply of `run`.
    pub fn covers(&self, run: &RunId) -> bool {
        self.finishing.as_ref().is_some_and(|s| &s.run == run)
            || self
                .writing
                .as_ref()
                .is_some_and(|s| s.run_id.as_ref() == Some(run))
    }
}

/// What this page has shown of unfinished answers.
#[derive(Clone, Debug, Default)]
pub struct LiveAnswer {
    latest: Option<Shown>,
    finishing: Option<Shown>,
    settled: BTreeSet<String>,
    unanswered: BTreeSet<String>,
}

impl LiveAnswer {
    /// The newest text shown for `run`, kept while its next update loads.
    pub fn text(&self, run: &RunId) -> Option<&str> {
        self.latest
            .as_ref()
            .filter(|shown| &shown.run == run)
            .map(|shown| shown.text.as_str())
    }

    pub fn is_settled(&self, run: &RunId) -> bool {
        self.settled.contains(&run.to_string())
    }

    /// Only a run that can still get a reply is kept on screen for one.
    fn waits_for_reply(&self, run: &RunId) -> bool {
        let run = run.to_string();
        !self.settled.contains(&run) && !self.unanswered.contains(&run)
    }

    /// The run of `status`, if it ended without a reply and that is not yet recorded.
    pub fn newly_unanswered(&self, status: &ExecutionStatus) -> Option<RunId> {
        use ExecutionPhase::{Blocked, CancelRequested, Cancelled, Failed};
        status
            .run_id
            .clone()
            .filter(|_| matches!(status.phase, Blocked | CancelRequested | Cancelled | Failed))
            .filter(|run| !self.unanswered.contains(&run.to_string()))
    }

    /// `run` will never get an accepted reply: it stays while the status is on
    /// it, as any stopped answer does, and leaves when the next run starts.
    pub fn unanswered(&mut self, run: &RunId) {
        self.unanswered.insert(run.to_string());
    }

    /// Text read for `run`. `None` means it was removed: forget it at once so
    /// a later render can never show it again.
    pub fn observed(&mut self, run: &RunId, text: Option<String>) {
        let Some(text) = text else {
            self.latest = self.latest.take().filter(|shown| &shown.run != run);
            self.finishing = self.finishing.take().filter(|shown| &shown.run != run);
            return;
        };
        let replaced = self.latest.replace(Shown {
            run: run.clone(),
            text,
        });
        // Another run's answer stays until its own reply can replace it.
        if let Some(previous) = replaced.filter(|shown| &shown.run != run) {
            if self.waits_for_reply(&previous.run) {
                self.finishing = Some(previous);
            }
        }
    }

    /// The accepted reply of `run` can show itself (or has nothing to show).
    pub fn settle(&mut self, run: &RunId) {
        self.settled.insert(run.to_string());
        // Replies arrive in order: an older run still waiting will not get one.
        self.finishing = None;
    }

    /// What to draw for the current execution status.
    pub fn rows(&self, status: Option<&ExecutionStatus>) -> LiveRows {
        let waiting = |shown: &&Shown| self.waits_for_reply(&shown.run);
        let writing = status
            .filter(|s| {
                s.progress.is_some()
                    && s.run_id.as_ref().is_some_and(|run| {
                        // A finished run is only followed to its handover: a
                        // reopened chat never replays an old answer as live.
                        !self.is_settled(run)
                            && (s.phase != ExecutionPhase::Completed || self.text(run).is_some())
                    })
            })
            .cloned();
        let current = status.and_then(|s| s.run_id.as_ref());
        // Newest first: a run the status has already moved past.
        let passed = self
            .latest
            .as_ref()
            .filter(|shown| Some(&shown.run) != current)
            .filter(waiting);
        LiveRows {
            finishing: passed.or(self.finishing.as_ref().filter(waiting)).cloned(),
            writing,
        }
    }
}
