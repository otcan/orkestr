//! The conversation's single authoritative run state, shown next to the
//! composer (ORK-786). The words and the controls offered come from the same
//! state, so they cannot disagree: Stop only for a queued or running run that
//! supports it, Steer only for a running run that supports it, and a finished
//! run never offers either. Presentation only; it grants nothing.
use crate::execution::{failure_label, model_label};
use orkestr_v2_contracts::{ExecutionPhase, ExecutionStatus};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunState {
    /// No status read has answered yet for this conversation.
    Checking,
    Idle,
    Queued,
    Running,
    /// Stop was requested; the provider has not confirmed it.
    Stopping,
    /// A reply waits for the owner (review and accept), or the run is blocked.
    AwaitingInput,
    Completed,
    Stopped,
    Failed,
    /// The status stream is lost or not current; nothing is inferred from it.
    Disconnected,
}

impl RunState {
    /// Stable name for markup (`data-run-state`) and tests.
    pub fn slug(self) -> &'static str {
        match self {
            Self::Checking => "checking",
            Self::Idle => "idle",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::AwaitingInput => "awaiting-input",
            Self::Completed => "completed",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
            Self::Disconnected => "disconnected",
        }
    }
}

/// What the run-state line shows, and which controls it offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunView {
    pub state: RunState,
    pub label: String,
    /// Optional secondary detail: the model a finished run reported.
    pub detail: Option<String>,
    pub stop: bool,
    pub steer: bool,
    pub accept: bool,
}

/// The read-only evidence the line is computed from.
#[derive(Clone, Copy, Debug)]
pub struct Observation<'a> {
    /// The selected conversation's current run, if any.
    pub status: Option<&'a ExecutionStatus>,
    /// A status read answered since the conversation was selected.
    pub observed: bool,
    /// The status stream is connected.
    pub connected: bool,
    /// The last status is recent enough to act on.
    pub fresh: bool,
    /// The conversation accepts replies without an Accept prompt.
    pub auto_accept: bool,
}

fn last_known(phase: ExecutionPhase) -> &'static str {
    match phase {
        ExecutionPhase::Queued => "queued",
        ExecutionPhase::Starting | ExecutionPhase::Running => "working",
        ExecutionPhase::CancelRequested => "stop requested",
        ExecutionPhase::Cancelled => "stopped",
        ExecutionPhase::AwaitingAcceptance => "reply ready",
        ExecutionPhase::Completed => "completed",
        ExecutionPhase::Failed => "failed",
        ExecutionPhase::Blocked => "needs attention",
    }
}

pub fn run_view(observation: Observation<'_>) -> RunView {
    let plain = |state, label: &str| RunView {
        state,
        label: label.to_owned(),
        detail: None,
        stop: false,
        steer: false,
        accept: false,
    };
    let Some(status) = observation.status else {
        return if !observation.observed {
            plain(RunState::Checking, "Checking work status…")
        } else if !observation.connected {
            plain(
                RunState::Disconnected,
                "Disconnected from work status · reconnecting",
            )
        } else {
            plain(RunState::Idle, "No work running")
        };
    };
    if !observation.connected || !observation.fresh {
        let lead = if observation.connected {
            "Status not current"
        } else {
            "Disconnected"
        };
        return plain(
            RunState::Disconnected,
            &format!(
                "{lead} · last known: {}. Reconnecting does not confirm completion.",
                last_known(status.phase)
            ),
        );
    }
    let has_run = status.run_id.is_some();
    let finished_detail = status.models.as_ref().map(|_| model_label(status));
    let mut view = match status.phase {
        ExecutionPhase::Queued => plain(RunState::Queued, "Queued"),
        ExecutionPhase::Starting => plain(RunState::Running, "Starting…"),
        ExecutionPhase::Running => plain(RunState::Running, "Working"),
        ExecutionPhase::CancelRequested => plain(
            RunState::Stopping,
            "Stop requested · waiting for confirmation",
        ),
        ExecutionPhase::AwaitingAcceptance if observation.auto_accept => plain(
            RunState::AwaitingInput,
            "Reply ready · accepting automatically",
        ),
        ExecutionPhase::AwaitingAcceptance => {
            plain(RunState::AwaitingInput, "Reply ready · review and accept")
        }
        ExecutionPhase::Blocked => plain(RunState::AwaitingInput, "Work needs your attention"),
        ExecutionPhase::Completed => plain(RunState::Completed, "Completed"),
        ExecutionPhase::Cancelled | ExecutionPhase::Failed => match &status.failure {
            Some(failure) => plain(
                RunState::Failed,
                &format!("Failed: {}", failure_label(failure.class)),
            ),
            None if status.phase == ExecutionPhase::Failed => plain(RunState::Failed, "Failed"),
            None => plain(RunState::Stopped, "Stopped"),
        },
    };
    view.stop = has_run
        && status.capabilities.stop
        && matches!(view.state, RunState::Queued | RunState::Running);
    view.steer = has_run && status.capabilities.steer && status.phase == ExecutionPhase::Running;
    view.accept = status.phase == ExecutionPhase::AwaitingAcceptance && !observation.auto_accept;
    if matches!(
        view.state,
        RunState::AwaitingInput | RunState::Completed | RunState::Stopped | RunState::Failed
    ) {
        view.detail = finished_detail;
    }
    view
}
