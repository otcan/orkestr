//! Pure live-map presentation: activity rules, filtering and labels. The map is
//! observation only; nothing here starts, stops or routes work.
use orkestr_v2_contracts::{
    runtime::RunState, ExecutionPhase, ExecutionWindowState, HostLiveMapStatus, LiveAgent,
    LiveConversation, LiveMap, LiveRole, LiveSession, LiveView, LiveWorker,
};

/// Poll cadence for the Live map page.
pub const REFRESH_MS: u64 = 10_000;
/// The host generator refreshes every 15 s; older than this is shown as stale.
pub const HOST_STALE_MS: i64 = 120_000;

pub fn agent_running(agent: &LiveAgent) -> bool {
    agent.status == "running"
}
pub fn session_active(session: &LiveSession) -> bool {
    session.live || session.agents.iter().any(agent_running)
}
pub fn role_active(role: &LiveRole) -> bool {
    matches!(
        role.phase,
        ExecutionPhase::Queued
            | ExecutionPhase::Starting
            | ExecutionPhase::Running
            | ExecutionPhase::CancelRequested
    )
}
pub fn worker_running(worker: &LiveWorker) -> bool {
    matches!(
        worker.state,
        RunState::Starting | RunState::Running | RunState::CancelRequested
    )
}
pub fn conversation_active(conversation: &LiveConversation) -> bool {
    conversation.window.as_ref().is_some_and(|w| {
        matches!(
            w.state,
            ExecutionWindowState::Opening
                | ExecutionWindowState::Active
                | ExecutionWindowState::Retiring
        )
    }) || conversation.fast.as_ref().is_some_and(role_active)
        || conversation.deep.as_ref().is_some_and(role_active)
        || conversation.workers.iter().any(worker_running)
}

/// The native conversation a view is delegated to, when the server linked one.
pub fn linked<'a>(map: &'a LiveMap, view: &LiveView) -> Option<&'a LiveConversation> {
    let id = view.delegated_to_v2.as_ref()?.conversation_id.as_ref()?;
    map.conversations.iter().find(|c| &c.conversation_id == id)
}

pub fn view_active(map: &LiveMap, view: &LiveView) -> bool {
    view.sessions.iter().any(session_active) || linked(map, view).is_some_and(conversation_active)
}

/// A filtered presentation of one view. `hidden_sessions` counts what the filter removed.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewRow<'a> {
    pub view: &'a LiveView,
    pub conversation: Option<&'a LiveConversation>,
    pub sessions: Vec<SessionRow<'a>>,
    pub hidden_sessions: usize,
}
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRow<'a> {
    pub session: &'a LiveSession,
    pub agents: Vec<&'a LiveAgent>,
    pub hidden_agents: usize,
}

pub fn views(map: &LiveMap, active_only: bool) -> Vec<ViewRow<'_>> {
    let mut rows: Vec<_> = map
        .host
        .views
        .iter()
        .filter(|view| !active_only || view_active(map, view))
        .map(|view| {
            let sessions: Vec<_> = view
                .sessions
                .iter()
                .filter(|s| !active_only || session_active(s))
                .map(|session| {
                    let agents: Vec<_> = session
                        .agents
                        .iter()
                        .filter(|a| !active_only || agent_running(a))
                        .collect();
                    SessionRow {
                        session,
                        hidden_agents: session.agents.len() - agents.len(),
                        agents,
                    }
                })
                .collect();
            ViewRow {
                view,
                conversation: linked(map, view),
                hidden_sessions: view.sessions.len() - sessions.len(),
                sessions,
            }
        })
        .collect();
    // Active views first, then most recent activity, then name.
    rows.sort_by_key(|row| {
        (
            !view_active(map, row.view),
            std::cmp::Reverse(last_activity(row.view)),
            row.view.name.clone().unwrap_or_default(),
        )
    });
    rows
}

fn last_activity(view: &LiveView) -> Option<i64> {
    view.sessions
        .iter()
        .flat_map(|s| {
            std::iter::once(s.last_activity_ms).chain(s.agents.iter().map(|a| a.last_activity_ms))
        })
        .flatten()
        .max()
}

/// Native conversations that no view links to, filtered by activity.
pub fn unlinked_conversations(map: &LiveMap, active_only: bool) -> Vec<&LiveConversation> {
    map.conversations
        .iter()
        .filter(|c| {
            !map.host.views.iter().any(|v| {
                v.delegated_to_v2
                    .as_ref()
                    .and_then(|d| d.conversation_id.as_ref())
                    == Some(&c.conversation_id)
            })
        })
        .filter(|c| !active_only || conversation_active(c))
        .collect()
}

/// Compact relative age against the server's own observation clock.
pub fn ago(now_ms: i64, then_ms: Option<i64>) -> String {
    let Some(then) = then_ms else {
        return "never".into();
    };
    let seconds = (now_ms - then).max(0) / 1000;
    match seconds {
        0..=59 => format!("{seconds}s ago"),
        60..=3_599 => format!("{}m ago", seconds / 60),
        3_600..=86_399 => format!("{}h ago", seconds / 3_600),
        _ => format!("{}d ago", seconds / 86_400),
    }
}

pub fn host_status(map: &LiveMap) -> String {
    let host = &map.host;
    match host.status {
        HostLiveMapStatus::Ready => {
            let age = host.modified_at_ms.or(host.generated_at_ms);
            let stale = age.is_none_or(|t| map.observed_at_ms - t > HOST_STALE_MS);
            format!(
                "Host map {} · generated {}",
                if stale { "stale" } else { "current" },
                ago(map.observed_at_ms, host.generated_at_ms.or(age))
            )
        }
        HostLiveMapStatus::Missing => "Host map not generated yet".into(),
        HostLiveMapStatus::Unreadable => "Host map unreadable by the server".into(),
        HostLiveMapStatus::TooLarge => "Host map exceeds the server size limit".into(),
        HostLiveMapStatus::Invalid => "Host map is not valid".into(),
    }
}

pub fn phase_label(phase: ExecutionPhase) -> &'static str {
    match phase {
        ExecutionPhase::Queued => "queued",
        ExecutionPhase::Starting => "starting",
        ExecutionPhase::Running => "running",
        ExecutionPhase::CancelRequested => "stopping",
        ExecutionPhase::Cancelled => "stopped",
        ExecutionPhase::AwaitingAcceptance => "awaiting acceptance",
        ExecutionPhase::Completed => "finished",
        ExecutionPhase::Failed => "failed",
        ExecutionPhase::Blocked => "blocked",
    }
}
pub fn run_label(state: RunState) -> &'static str {
    match state {
        RunState::Starting => "starting",
        RunState::Running => "running",
        RunState::CancelRequested => "stopping",
        RunState::Cancelled => "stopped",
        RunState::Blocked => "blocked",
        RunState::Failed => "failed",
        RunState::AwaitingAcceptance => "awaiting acceptance",
        RunState::Succeeded => "finished",
    }
}
pub fn window_label(state: ExecutionWindowState) -> &'static str {
    match state {
        ExecutionWindowState::Opening => "opening",
        ExecutionWindowState::Active => "active",
        ExecutionWindowState::Retiring => "retiring",
        ExecutionWindowState::Closed => "closed",
        ExecutionWindowState::ReconciliationRequired => "needs reconciliation",
    }
}

/// Session kind for display (`claude-code` → `Claude Code`).
pub fn kind_label(kind: &str) -> &str {
    match kind {
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "unknown" => "Unknown session",
        other => other,
    }
}

/// Short identifiers in full; long ones (UUIDs) by their first eight characters.
/// The full value goes in the tooltip.
pub fn short_id(id: &str) -> &str {
    if id.chars().count() <= 24 {
        return id;
    }
    let end = id.char_indices().nth(8).map(|(i, _)| i).unwrap_or(id.len());
    &id[..end]
}
