//! Per-conversation list badges from read-only execution and queue observations.
//! A badge is presentation only; it never admits, stops or accepts work.
use orkestr_v2_contracts::{
    ExecutionPhase, ExecutionStatus, ExecutionWindowQueue, QueuedWindowState,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Working,
    Queued,
    Attention,
}
impl Tone {
    pub fn class(self) -> &'static str {
        match self {
            Tone::Working => "status-working",
            Tone::Queued => "status-queued",
            Tone::Attention => "status-attention",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowStatus {
    pub label: String,
    pub tone: Tone,
}

/// Owner-wide work counts reported by any conversation's queue read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Slots {
    pub capacity: u32,
    pub active: u32,
    pub queued: u32,
}
impl Slots {
    pub fn label(&self) -> String {
        let mut text = format!("{} working", self.active.min(self.capacity));
        if self.queued > 0 {
            text.push_str(&format!(" · {} waiting", self.queued));
        }
        text
    }
}

pub fn valid_queue(queue: &ExecutionWindowQueue, id: &str) -> bool {
    queue.conversation_id.to_string() == id
        && (1..=64).contains(&queue.capacity)
        && queue.entries.len() <= 256
        && queue
            .entries
            .iter()
            .all(|e| e.conversation_id == queue.conversation_id)
}

pub fn valid_execution(status: &ExecutionStatus, id: &str) -> bool {
    status.conversation_id.to_string() == id && status.is_valid()
}

/// The single most relevant badge; `None` means idle or unknown.
pub fn row_status(
    execution: Option<&ExecutionStatus>,
    queue: Option<&ExecutionWindowQueue>,
) -> Option<RowStatus> {
    let waiting = queue.map(|q| {
        q.entries
            .iter()
            .filter(|e| e.state == QueuedWindowState::Queued)
            .filter_map(|e| e.position)
            .min()
    });
    let queued = queue.is_some_and(|q| {
        q.entries
            .iter()
            .any(|e| e.state == QueuedWindowState::Queued)
    });
    let phase = execution.map(|s| s.phase);
    let (label, tone) = match phase {
        Some(ExecutionPhase::AwaitingAcceptance) => ("Reply ready".to_string(), Tone::Attention),
        Some(ExecutionPhase::Blocked) => ("Needs attention".into(), Tone::Attention),
        Some(ExecutionPhase::Failed) => ("Failed".into(), Tone::Attention),
        Some(ExecutionPhase::Running) => ("Working".into(), Tone::Working),
        Some(ExecutionPhase::Starting) => ("Starting".into(), Tone::Working),
        Some(ExecutionPhase::CancelRequested) => ("Stopping".into(), Tone::Working),
        _ if queued => (
            match waiting.flatten() {
                Some(position) => format!("Queued #{position}"),
                None => "Queued".into(),
            },
            Tone::Queued,
        ),
        Some(ExecutionPhase::Queued) => ("Waiting".into(), Tone::Queued),
        _ => return None,
    };
    Some(RowStatus { label, tone })
}
