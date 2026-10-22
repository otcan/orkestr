//! V1 worker sub-threads of a conversation's linked V1 thread (Work tab).
//! Presentation only: listing a worker never starts or steers it.
use orkestr_v2_contracts::{SidebarV1Status, V1WorkerEntry, V1WorkerState, V1WorkersPage};

/// Whether the Work tab shows the section at all: only for a conversation
/// linked to a V1 thread.
pub fn shown(page: &V1WorkersPage) -> bool {
    page.v1_thread_id.is_some()
}

/// Workers to list; retired ones only when asked for.
pub fn visible(page: &V1WorkersPage, show_retired: bool) -> Vec<&V1WorkerEntry> {
    page.workers
        .iter()
        .filter(|w| show_retired || w.state != V1WorkerState::Retired)
        .collect()
}

pub fn state_label(state: V1WorkerState) -> &'static str {
    match state {
        V1WorkerState::Working => "working",
        V1WorkerState::Idle => "idle",
        V1WorkerState::Retired => "retired",
    }
}

/// Where the worker opens: its V2 conversation when it was imported,
/// otherwise its linked V1 entry when the sidebar lists it.
pub fn link(worker: &V1WorkerEntry) -> Option<String> {
    match &worker.conversation_id {
        Some(id) => Some(format!("#conversation/{id}")),
        None if worker.openable => Some(format!("#v1/{}", worker.thread_id)),
        None => None,
    }
}

/// The "show retired (n)" toggle text; `None` without retired workers.
pub fn retired_toggle(page: &V1WorkersPage, showing: bool) -> Option<String> {
    match (page.retired, showing) {
        (0, _) => None,
        (n, false) => Some(format!("Show retired ({n})")),
        (n, true) => Some(format!("Hide retired ({n})")),
    }
}

/// One line under the heading: why the list may be empty or partial.
pub fn notice(page: &V1WorkersPage, show_retired: bool) -> Option<&'static str> {
    match page.v1_status {
        SidebarV1Status::Unavailable => Some("V1 is not reachable right now."),
        SidebarV1Status::Unconfigured | SidebarV1Status::MapOnly => {
            Some("V1 workers are not available on this server.")
        }
        SidebarV1Status::Ready if visible(page, show_retired).is_empty() => Some("No V1 workers"),
        SidebarV1Status::Ready if page.truncated => Some("Showing the most recent V1 workers."),
        SidebarV1Status::Ready => None,
    }
}
