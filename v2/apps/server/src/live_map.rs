//! Owner live map. Merges an operator-configured external view map (read-only,
//! size-capped, validated) with native conversation, window and Worker state.
//! External transcript paths are parsed away and never reach the browser.
use super::*;
use orkestr_v2_contracts::{
    HostLiveMap, HostLiveMapStatus, LiveAgent, LiveConversation, LiveDelegation, LiveMap, LiveRole,
    LiveSession, LiveView, LiveWindow, LiveWorker, LIVE_MAP_MAX_AGENTS, LIVE_MAP_MAX_CONVERSATIONS,
    LIVE_MAP_MAX_SESSIONS, LIVE_MAP_MAX_TEXT, LIVE_MAP_MAX_VIEWS,
};
use std::{
    io::Read,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

/// Server-side environment key naming the external live-map JSON file.
pub const LIVE_MAP_ENV: &str = "ORKESTR_V2_LIVE_MAP";
/// The external file is never read past this many bytes.
pub(crate) const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

impl AppState {
    /// Trusted startup only: enable the live map with an external view file.
    pub fn with_live_map_file(mut self, path: &Path) -> Result<Self, &'static str> {
        let text = path.to_str().ok_or("live map path must be UTF-8")?;
        if !path.is_absolute()
            || text.len() > 4096
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("live map path must be absolute without parent components");
        }
        self.live_map = Some(Arc::new(path.to_owned()));
        Ok(self)
    }
}

pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    let credential = browser::credential(&headers)?;
    let path = state.live_map.clone().ok_or(Error(
        StatusCode::NOT_FOUND,
        "live_map_unconfigured",
        "Live map is not configured",
    ))?;
    let host = tokio::task::spawn_blocking(move || read_host(&path, MAX_FILE_BYTES))
        .await
        .map_err(|_| unavailable())?;
    let (conversations, truncated) = native(&state, &owner, &credential).await?;
    let map = merge(host, conversations, truncated, now_ms());
    if !map.is_valid() {
        return Err(unavailable());
    }
    Ok(Json(map).into_response())
}

fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "live_map_unavailable",
        "Live map unavailable",
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(1)
        .max(1)
}

/// Link delegated views to native conversations of this owner.
pub(crate) fn merge(
    mut host: HostLiveMap,
    conversations: Vec<LiveConversation>,
    truncated: bool,
    observed_at_ms: i64,
) -> LiveMap {
    for view in &mut host.views {
        if let Some(delegation) = &mut view.delegated_to_v2 {
            delegation.conversation_id = delegation
                .remote_thread_id
                .as_deref()
                .and_then(|id| Uuid::parse_str(id).ok())
                .map(ConversationId)
                .filter(|id| conversations.iter().any(|c| &c.conversation_id == id));
        }
    }
    LiveMap {
        schema_version: 1,
        observed_at_ms,
        host,
        conversations,
        conversations_truncated: truncated,
    }
}

async fn native(
    state: &AppState,
    owner: &OwnerId,
    credential: &str,
) -> Result<(Vec<LiveConversation>, bool), Error> {
    let page = state
        .store
        .conversations_authenticated(credential, 0, LIVE_MAP_MAX_CONVERSATIONS as u32)
        .await
        .map_err(|error| match error {
            orkestr_v2_application::runtime::RuntimeStoreError::Unauthorized => unauthorized(),
            _ => unavailable(),
        })?;
    let truncated = page.next_cursor.is_some();
    let mut out = Vec::with_capacity(page.conversations.len());
    for summary in page.conversations {
        out.push(conversation(state, owner, credential, summary).await);
    }
    Ok((out, truncated))
}

async fn conversation(
    state: &AppState,
    owner: &OwnerId,
    credential: &str,
    summary: ConversationSummary,
) -> LiveConversation {
    let id = summary.conversation_id;
    let mut partial = false;
    // Durable window row only: observation never sweeps or reconciles windows.
    let window = match state
        .store
        .execution_window_status_authenticated(credential, &id)
        .await
    {
        Ok(window) => window.map(|w| LiveWindow {
            window_id: w.window_id,
            generation: w.generation,
            state: w.state,
            opened_at_ms: w.opened_at_ms,
            work_deadline_ms: w.work_deadline_ms,
            expires_at_ms: w.expires_at_ms,
        }),
        Err(_) => {
            partial = true;
            None
        }
    };
    let role = |status: ExecutionStatus| LiveRole {
        run_id: status.run_id,
        phase: status.phase,
        observed_at_ms: status.observed_at_ms,
    };
    let deep = match state.store.execution_status(owner, &id).await {
        Ok(status) => status.filter(|s| s.is_valid()).map(role),
        Err(_) => {
            partial = true;
            None
        }
    };
    let fast = match state.fast_execution_scope(owner, &id).await {
        Ok(Some(scope)) => match scope
            .store
            .execution_fast_status_authenticated(credential, &id)
            .await
        {
            Ok(status) => status.filter(|s| s.is_valid()).map(role),
            Err(_) => {
                partial = true;
                None
            }
        },
        Ok(None) => None,
        Err(_) => {
            partial = true;
            None
        }
    };
    let workers = match state.execution_scope(owner, &id).await {
        Ok(Some(scope)) => match scope
            .store
            .worker_executions_authenticated(credential, &id, None, 100)
            .await
        {
            Ok(page) if page.is_valid() && page.conversation_id == id => page
                .workers
                .into_iter()
                .map(|w| LiveWorker {
                    run_id: w.run_id,
                    session_id: w.session_id,
                    parent_run_id: w.parent_run_id,
                    state: w.state,
                    recovery: w.recovery,
                })
                .collect(),
            _ => {
                partial = true;
                Vec::new()
            }
        },
        Ok(None) => Vec::new(),
        Err(_) => {
            partial = true;
            Vec::new()
        }
    };
    LiveConversation {
        conversation_id: id,
        name: summary.name,
        window,
        fast,
        deep,
        workers,
        partial,
    }
}

fn host(status: HostLiveMapStatus, modified_at_ms: Option<i64>) -> HostLiveMap {
    HostLiveMap {
        status,
        generated_at_ms: None,
        modified_at_ms,
        views: Vec::new(),
    }
}

/// Read-only, capped read of the external file. Never follows into a parse
/// of a truncated prefix; any failure is reported as a status, not an error.
pub(crate) fn read_host(path: &Path, cap: u64) -> HostLiveMap {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return host(HostLiveMapStatus::Missing, None)
        }
        Err(_) => return host(HostLiveMapStatus::Unreadable, None),
    };
    let Ok(metadata) = file.metadata() else {
        return host(HostLiveMapStatus::Unreadable, None);
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok());
    if !metadata.is_file() {
        return host(HostLiveMapStatus::Unreadable, modified);
    }
    if metadata.len() > cap {
        return host(HostLiveMapStatus::TooLarge, modified);
    }
    let mut bytes = Vec::new();
    if file.take(cap + 1).read_to_end(&mut bytes).is_err() {
        return host(HostLiveMapStatus::Unreadable, modified);
    }
    if bytes.len() as u64 > cap {
        return host(HostLiveMapStatus::TooLarge, modified);
    }
    match parse(&bytes) {
        Some((generated_at_ms, views)) => HostLiveMap {
            status: HostLiveMapStatus::Ready,
            generated_at_ms,
            modified_at_ms: modified,
            views,
        },
        None => host(HostLiveMapStatus::Invalid, modified),
    }
}

mod input {
    //! External generator schema. Unknown fields, including every `transcript`
    //! path, are deliberately not modelled and so never leave this module.
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Map {
        pub generated_at: Option<String>,
        pub views: Vec<View>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct View {
        pub view: String,
        pub name: Option<String>,
        pub chat_id: Option<String>,
        pub thread_id: Option<String>,
        pub fast_layer: Option<String>,
        pub delegated_to_v2: Option<Delegation>,
        #[serde(default)]
        pub sessions: Vec<Session>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Delegation {
        pub remote_backend: Option<String>,
        pub remote_thread_id: Option<String>,
        pub remote_runtime_enabled: Option<bool>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Session {
        pub session_id: Option<String>,
        pub kind: Option<String>,
        pub role: Option<String>,
        #[serde(default)]
        pub live: bool,
        pub last_activity: Option<String>,
        #[serde(default)]
        pub agents: Vec<Agent>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Agent {
        pub agent_id: String,
        pub name: Option<String>,
        pub status: Option<String>,
        pub started_at: Option<String>,
        pub last_activity: Option<String>,
    }
}

fn text(value: String) -> Option<String> {
    (value.chars().count() <= LIVE_MAP_MAX_TEXT && !value.chars().any(char::is_control))
        .then_some(value)
}
/// Display names are free text: bounded and control-free, never a refusal.
fn label(value: Option<String>) -> Option<String> {
    value.map(|v| {
        v.chars()
            .take(LIVE_MAP_MAX_TEXT)
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect()
    })
}
fn optional(value: Option<String>) -> Option<Option<String>> {
    match value {
        None => Some(None),
        Some(value) => text(value).map(Some),
    }
}

/// Parse and validate. `None` means the whole document is refused.
pub(crate) fn parse(bytes: &[u8]) -> Option<(Option<i64>, Vec<LiveView>)> {
    let map: input::Map = serde_json::from_slice(bytes).ok()?;
    if map.views.len() > LIVE_MAP_MAX_VIEWS {
        return None;
    }
    let generated = map.generated_at.as_deref().and_then(timestamp_ms);
    let mut views = Vec::with_capacity(map.views.len());
    for view in map.views {
        if view.sessions.len() > LIVE_MAP_MAX_SESSIONS {
            return None;
        }
        let mut sessions = Vec::with_capacity(view.sessions.len());
        for session in view.sessions {
            if session.agents.len() > LIVE_MAP_MAX_AGENTS {
                return None;
            }
            let mut agents = Vec::with_capacity(session.agents.len());
            for agent in session.agents {
                agents.push(LiveAgent {
                    agent_id: text(agent.agent_id)?,
                    name: label(agent.name),
                    status: text(agent.status.unwrap_or_else(|| "unknown".into()))?,
                    started_at_ms: agent.started_at.as_deref().and_then(timestamp_ms),
                    last_activity_ms: agent.last_activity.as_deref().and_then(timestamp_ms),
                });
            }
            sessions.push(LiveSession {
                session_id: text(session.session_id.unwrap_or_default())?,
                kind: text(session.kind.unwrap_or_else(|| "unknown".into()))?,
                role: text(session.role.unwrap_or_else(|| "attached".into()))?,
                live: session.live,
                last_activity_ms: session.last_activity.as_deref().and_then(timestamp_ms),
                agents,
            });
        }
        let delegated_to_v2 = match view.delegated_to_v2 {
            None => None,
            Some(d) => Some(LiveDelegation {
                remote_backend: optional(d.remote_backend)?,
                remote_thread_id: optional(d.remote_thread_id)?,
                remote_runtime_enabled: d.remote_runtime_enabled,
                conversation_id: None,
            }),
        };
        views.push(LiveView {
            view: text(view.view)?,
            name: label(view.name),
            chat_id: optional(view.chat_id)?,
            thread_id: optional(view.thread_id)?,
            fast_layer: optional(view.fast_layer)?,
            delegated_to_v2,
            sessions,
        });
    }
    Some((generated, views))
}

/// RFC 3339 / Python `isoformat()` to Unix milliseconds; `None` if unparseable.
pub(crate) fn timestamp_ms(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    if b.len() < 19 || b.len() > 40 || !value.is_ascii() {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        let s = value.get(range)?;
        s.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| s.parse().ok())?
    };
    if b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' {
        return None;
    }
    if b[16] != b':' {
        return None;
    }
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = &value[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let padded = format!("{:0<3}", &fraction[..digits.min(3)]);
        millis = padded.parse::<i64>().ok()?;
        rest = &fraction[digits..];
    }
    let offset_minutes = match rest {
        "Z" | "z" => 0,
        _ if rest.len() == 6 && rest.as_bytes()[3] == b':' => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let h: i64 = rest[1..3].parse().ok()?;
            let m: i64 = rest[4..6].parse().ok()?;
            if h > 23 || m > 59 {
                return None;
            }
            sign * (h * 60 + m)
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant), proleptic Gregorian.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millis)
}

#[cfg(test)]
#[path = "live_map_tests.rs"]
mod tests;
