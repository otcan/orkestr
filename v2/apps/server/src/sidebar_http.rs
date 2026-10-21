//! Owner conversation sidebar. Native conversations and linked V1 threads in
//! one activity-ordered list with previews, unread counts and live activity;
//! forward-only read marks; write-once lineage of imported conversations;
//! recent history of linked V1 threads and owner input into them, which V1
//! admits and runs exactly as input from its own web UI.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::sidebar_v1::{self, V1Thread};
use axum::extract::{
    rejection::{JsonRejection, QueryRejection},
    Path, Query,
};
use orkestr_v2_contracts::runtime::RunState;
use orkestr_v2_store_sqlite::{ResourceError, SidebarConversation};
use std::collections::{BTreeMap, HashMap, HashSet};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/sidebar", get(read))
        .route("/api/v2/sidebar/read", axum::routing::put(mark_read))
        .route(
            "/api/v2/v1-threads/{thread}/messages",
            get(v1_history).post(v1_send),
        )
        .route(
            "/api/v2/conversations/{id}/lineage",
            axum::routing::put(record_lineage),
        )
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_sidebar_request",
        "Invalid sidebar request",
    )
}
fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "sidebar_unavailable",
        "Conversation sidebar unavailable",
    )
}
fn failure(error: ResourceError) -> Error {
    match error {
        ResourceError::Invalid => invalid(),
        ResourceError::Unauthorized => unauthorized(),
        ResourceError::NotFound => {
            Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
        }
        ResourceError::Conflict("lineage_conflict") => Error(
            StatusCode::CONFLICT,
            "lineage_conflict",
            "A different lineage is already recorded",
        ),
        ResourceError::Conflict(_) => Error(
            StatusCode::CONFLICT,
            "lineage_source_not_imported",
            "The source thread is not imported into this conversation",
        ),
        ResourceError::Unavailable => unavailable(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(1)
        .max(1)
}

/// Where linked (not yet migrated) V1 entries come from.
pub(crate) enum LinkedSource<'a> {
    /// The V1 thread registry (authoritative names, parents, activity).
    Registry(&'a [V1Thread]),
    /// Only the host live map: views and attached sessions.
    Map(&'a [LiveView]),
    None,
}

/// Native input to [`compose`]: the store row and its live runtime state.
pub(crate) struct Native {
    pub row: SidebarConversation,
    pub activity: SidebarActivity,
}

fn active(state: &RunState) -> bool {
    matches!(
        state,
        RunState::Starting | RunState::Running | RunState::CancelRequested
    )
}
fn running(phase: ExecutionPhase) -> bool {
    matches!(
        phase,
        ExecutionPhase::Starting | ExecutionPhase::Running | ExecutionPhase::CancelRequested
    )
}

/// Live state from durable rows: the window, the Fast and Deep roles and the
/// Worker runs. Closed or absent windows are idle without further reads.
pub(crate) fn activity(live: &LiveConversation) -> SidebarActivity {
    let window = live.window.as_ref().map(|w| w.state);
    SidebarActivity {
        fast: live.fast.as_ref().is_some_and(|r| running(r.phase)),
        // An opening window has admitted work whose Deep turn is starting.
        deep: live.deep.as_ref().is_some_and(|r| running(r.phase))
            || window == Some(ExecutionWindowState::Opening),
        workers: live.workers.iter().filter(|w| active(&w.state)).count() as u32,
    }
}

/// Views with a live attached session (e.g. a coordinator via V1 `api-session`).
pub(crate) fn coordinators(views: &[LiveView]) -> HashSet<String> {
    views
        .iter()
        .filter(|v| v.sessions.iter().any(|s| s.live && s.role == "attached"))
        .filter_map(|v| v.thread_id.clone())
        .collect()
}

/// Build the page. Pure: every input was read before.
#[allow(clippy::too_many_arguments)]
pub(crate) fn compose(
    native: Vec<Native>,
    linked: LinkedSource<'_>,
    v1_marks: &BTreeMap<String, i64>,
    previews: &HashMap<String, SidebarPreview>,
    coordinator: &HashSet<String>,
    v1_status: SidebarV1Status,
    truncated: bool,
    observed_at_ms: i64,
) -> SidebarPage {
    // V1 thread -> native entry it was imported into.
    let mut imported: HashMap<String, String> = HashMap::new();
    for n in &native {
        let thread = n
            .row
            .lineage
            .as_ref()
            .map(|l| l.source_thread_id.clone())
            .or_else(|| n.row.source_thread_id.clone());
        if let Some(thread) = thread.filter(|t| valid_v1_thread_id(t)) {
            imported
                .entry(thread)
                .or_insert_with(|| format!("v2:{}", n.row.conversation_id));
        }
    }
    let registry: HashMap<&str, &V1Thread> = match &linked {
        LinkedSource::Registry(threads) => threads.iter().map(|t| (t.id.as_str(), t)).collect(),
        _ => HashMap::new(),
    };
    let mut entries: Vec<(SidebarEntry, Option<String>)> = Vec::new();
    for n in native {
        let row = n.row;
        let thread = row
            .lineage
            .as_ref()
            .map(|l| l.source_thread_id.clone())
            .or(row.source_thread_id.clone())
            .filter(|t| valid_v1_thread_id(t));
        // Durable lineage first; the V1 registry fills a link not yet recorded.
        let parent = row
            .lineage
            .as_ref()
            .and_then(|l| l.source_parent_thread_id.clone())
            .or_else(|| {
                let record = registry.get(thread.as_deref()?)?;
                (record.kind.as_deref() != Some("task-agent"))
                    .then(|| record.parent.clone())
                    .flatten()
            });
        let last = [
            row.last_event_at.as_deref(),
            row.last_archived_at.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter_map(crate::live_map::timestamp_ms)
        .filter(|t| *t > 0)
        .max();
        let preview = row
            .preview
            .as_ref()
            .and_then(|(author, text)| sidebar_v1::preview(*author, text));
        entries.push((
            SidebarEntry {
                key: format!("v2:{}", row.conversation_id),
                source: SidebarSource::V2,
                name: sidebar_v1::display(&row.name, SIDEBAR_NAME_MAX),
                conversation_id: Some(row.conversation_id),
                v1_thread_id: thread,
                parent_key: None,
                last_activity_ms: last,
                preview,
                unread: row.unread,
                activity: n.activity,
                read_only: false,
                coordinator: false,
                read_marker: row.sequence.max(0),
            },
            parent,
        ));
    }
    match linked {
        LinkedSource::Registry(threads) => {
            for thread in sidebar_v1::listed(threads, &|id| imported.contains_key(id)) {
                let mark = v1_marks.get(&thread.id).copied();
                let unread = u32::from(
                    thread.last_role.as_deref() == Some("assistant")
                        && mark.is_some_and(|m| thread.last_cursor > m),
                );
                entries.push((
                    SidebarEntry {
                        key: format!("v1:{}", thread.id),
                        source: SidebarSource::V1,
                        name: thread.name.clone(),
                        conversation_id: None,
                        v1_thread_id: Some(thread.id.clone()),
                        parent_key: None,
                        last_activity_ms: thread.last_activity_ms,
                        preview: previews.get(&thread.id).cloned(),
                        unread,
                        activity: SidebarActivity {
                            deep: thread.working,
                            ..Default::default()
                        },
                        read_only: true,
                        coordinator: coordinator.contains(&thread.id),
                        read_marker: thread.last_cursor,
                    },
                    thread.parent.clone(),
                ));
            }
        }
        LinkedSource::Map(views) => {
            let ids: HashSet<&str> = views
                .iter()
                .filter_map(|v| v.thread_id.as_deref())
                .collect();
            let mut seen = HashSet::new();
            for view in views {
                let Some(id) = view.thread_id.as_deref().filter(|t| valid_v1_thread_id(t)) else {
                    continue;
                };
                if imported.contains_key(id) || !seen.insert(id) {
                    continue;
                }
                let name = view
                    .name
                    .as_deref()
                    .map(|n| sidebar_v1::display(n, SIDEBAR_NAME_MAX))
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| id.to_owned());
                entries.push((
                    SidebarEntry {
                        key: format!("v1:{id}"),
                        source: SidebarSource::V1,
                        name,
                        conversation_id: None,
                        v1_thread_id: Some(id.to_owned()),
                        parent_key: None,
                        last_activity_ms: view
                            .sessions
                            .iter()
                            .filter_map(|s| s.last_activity_ms)
                            .filter(|t| *t > 0)
                            .max(),
                        preview: None,
                        unread: 0,
                        activity: SidebarActivity::default(),
                        read_only: true,
                        coordinator: coordinator.contains(id),
                        read_marker: 0,
                    },
                    sidebar_v1::encoded_parent(id, &|p| ids.contains(p)),
                ));
            }
        }
        LinkedSource::None => {}
    }
    let keys: HashSet<String> = entries.iter().map(|(e, _)| e.key.clone()).collect();
    let mut out: Vec<SidebarEntry> = entries
        .into_iter()
        .map(|(mut entry, parent)| {
            entry.parent_key = parent
                .and_then(|p| {
                    imported
                        .get(&p)
                        .cloned()
                        .or_else(|| Some(format!("v1:{p}")))
                })
                .filter(|p| *p != entry.key && keys.contains(p));
            entry
        })
        .collect();
    out.sort_by(|a, b| {
        b.last_activity_ms
            .cmp(&a.last_activity_ms)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.key.cmp(&b.key))
    });
    let truncated = truncated || out.len() > SIDEBAR_MAX_ENTRIES;
    out.truncate(SIDEBAR_MAX_ENTRIES);
    // A parent cut by truncation leaves its children at the top level.
    let kept: HashSet<String> = out.iter().map(|e| e.key.clone()).collect();
    for entry in &mut out {
        if entry.parent_key.as_ref().is_some_and(|p| !kept.contains(p)) {
            entry.parent_key = None;
        }
    }
    SidebarPage {
        schema_version: 1,
        observed_at_ms,
        v1_status,
        entries: out,
        truncated,
    }
}

async fn native_activity(
    state: &AppState,
    owner: &OwnerId,
    credential: &str,
    row: &SidebarConversation,
) -> SidebarActivity {
    // One durable window read per conversation; roles only for open windows.
    let open = matches!(
        state
            .store
            .execution_window_status_authenticated(credential, &row.conversation_id)
            .await,
        Ok(Some(ref w)) if matches!(
            w.state,
            ExecutionWindowState::Opening | ExecutionWindowState::Active | ExecutionWindowState::Retiring
        )
    );
    if !open {
        return SidebarActivity::default();
    }
    let summary = ConversationSummary {
        conversation_id: row.conversation_id.clone(),
        name: row.name.clone(),
        scope: Scope::Global,
        last_sequence: row.sequence,
    };
    activity(&crate::live_map::conversation(state, owner, credential, summary).await)
}

/// Linked V1 threads plus coordinator flags, from the registry or the map.
struct Linked {
    status: SidebarV1Status,
    registry: Option<Arc<Vec<V1Thread>>>,
    views: Vec<LiveView>,
}
async fn linked(state: &AppState) -> Linked {
    let views = match state.live_map.clone() {
        Some(path) => tokio::task::spawn_blocking(move || {
            crate::live_map::read_host(&path, crate::live_map::MAX_FILE_BYTES)
        })
        .await
        .map(|h| h.views)
        .unwrap_or_default(),
        None => Vec::new(),
    };
    let (status, registry) = match &state.desktop_broker {
        Some(broker) => match state.sidebar_v1.registry(broker).await {
            Some(threads) => (SidebarV1Status::Ready, Some(threads)),
            None => (SidebarV1Status::Unavailable, None),
        },
        None if state.live_map.is_some() => (SidebarV1Status::MapOnly, None),
        None => (SidebarV1Status::Unconfigured, None),
    };
    Linked {
        status,
        registry,
        views,
    }
}

pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let list = state
        .store
        .sidebar_conversations(&credential, &owner)
        .await
        .map_err(failure)?;
    let mut native = Vec::with_capacity(list.conversations.len());
    for row in list.conversations {
        let activity = native_activity(&state, &owner, &credential, &row).await;
        native.push(Native { row, activity });
    }
    let linked = linked(&state).await;
    let coordinator = coordinators(&linked.views);
    let mut previews = HashMap::new();
    let source = match (&linked.registry, linked.status) {
        (Some(threads), _) => {
            if let Some(broker) = &state.desktop_broker {
                let imported: HashSet<String> = native
                    .iter()
                    .filter_map(|n| {
                        n.row
                            .lineage
                            .as_ref()
                            .map(|l| l.source_thread_id.clone())
                            .or_else(|| n.row.source_thread_id.clone())
                    })
                    .collect();
                let mut shown = sidebar_v1::listed(threads, &|id| imported.contains(id));
                shown.sort_by_key(|t| std::cmp::Reverse(t.last_activity_ms));
                previews = state.sidebar_v1.previews(broker, &shown).await;
            }
            LinkedSource::Registry(threads)
        }
        (None, SidebarV1Status::MapOnly | SidebarV1Status::Unavailable) => {
            LinkedSource::Map(&linked.views)
        }
        _ => LinkedSource::None,
    };
    let page = compose(
        native,
        source,
        &list.v1_marks,
        &previews,
        &coordinator,
        linked.status,
        list.truncated,
        now_ms(),
    );
    if !page.is_valid() {
        return Err(unavailable());
    }
    Ok(Json(page).into_response())
}

pub(crate) async fn mark_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<SidebarReadMark>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Json(mark) = body.map_err(|_| invalid())?;
    let key = SidebarKey::parse(&mark.key)
        .filter(|_| mark.is_valid())
        .ok_or_else(invalid)?;
    let marker = state
        .store
        .mark_sidebar_read(&credential, &owner, &key, mark.marker)
        .await
        .map_err(failure)?;
    Ok(Json(SidebarReadMark {
        key: key.to_string(),
        marker,
    })
    .into_response())
}

pub(crate) async fn record_lineage(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ConversationLineage>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = Uuid::parse_str(&id)
        .ok()
        .filter(|id| !id.is_nil())
        .map(ConversationId)
        .ok_or_else(invalid)?;
    let Json(lineage) = body.map_err(|_| invalid())?;
    let inserted = state
        .store
        .record_conversation_lineage(&credential, &owner, &conversation, &lineage)
        .await
        .map_err(failure)?;
    Ok((
        if inserted {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(lineage),
    )
        .into_response())
}

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoryQuery {
    before: Option<i64>,
}

/// Recent history of a linked V1 thread. Only threads the sidebar lists
/// (owner group threads and their sub-threads, not migrated) are readable.
pub(crate) async fn v1_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
    query: Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Query(query) = query.map_err(|_| invalid())?;
    if !valid_v1_thread_id(&thread) || query.before.is_some_and(|b| b < 0) {
        return Err(invalid());
    }
    let (broker, record) = listed_thread(&state, &owner, &credential, &thread).await?;
    let linked = linked(&state).await;
    let coordinator = coordinators(&linked.views).contains(&record.id);
    let page = state
        .sidebar_v1
        .history(&broker, &record, coordinator, query.before)
        .await
        .map_err(|error| match error {
            crate::desktop_broker::BrokerError::Denied => not_listed(),
            _ => unavailable(),
        })?;
    if !page.is_valid() {
        return Err(unavailable());
    }
    Ok(Json(page).into_response())
}

fn not_listed() -> Error {
    Error(StatusCode::NOT_FOUND, "not_found", "V1 thread not listed")
}

/// The V1 client and a thread the sidebar lists (owner group threads and
/// their sub-threads, not imported into V2). Anything else is not found.
async fn listed_thread(
    state: &AppState,
    owner: &OwnerId,
    credential: &str,
    thread: &str,
) -> Result<(Arc<crate::desktop_broker::Broker>, V1Thread), Error> {
    let broker = state.desktop_broker.clone().ok_or(Error(
        StatusCode::NOT_FOUND,
        "v1_unconfigured",
        "V1 history is not configured",
    ))?;
    let list = state
        .store
        .sidebar_conversations(credential, owner)
        .await
        .map_err(failure)?;
    let imported: HashSet<String> = list
        .conversations
        .iter()
        .filter_map(|c| {
            c.lineage
                .as_ref()
                .map(|l| l.source_thread_id.clone())
                .or_else(|| c.source_thread_id.clone())
        })
        .collect();
    let threads = state
        .sidebar_v1
        .registry(&broker)
        .await
        .ok_or_else(unavailable)?;
    let record = sidebar_v1::listed(&threads, &|id| imported.contains(id))
        .into_iter()
        .find(|t| t.id == thread)
        .cloned()
        .ok_or_else(not_listed)?;
    Ok((broker, record))
}

/// Owner input into a linked V1 thread, forwarded as V1 web UI input
/// (`ui-input`): V1 records it as owner input and runs or routes it as usual
/// (for a coordinated thread, its attached session sees it). Exactly once:
/// the client key becomes V1's `clientMessageId`, which V1 dedupes, so a retry
/// after an unknown outcome returns the first message. A thread delegated to
/// V2 is refused: its input belongs to its V2 conversation, never to V1 too.
pub(crate) async fn v1_send(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
    body: Result<Json<V1ThreadInput>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Json(input) = body.map_err(|_| invalid())?;
    if !valid_v1_thread_id(&thread) || !input.is_valid() {
        return Err(invalid());
    }
    let (broker, record) = listed_thread(&state, &owner, &credential, &thread).await?;
    if record.delegated {
        return Err(Error(
            StatusCode::CONFLICT,
            "v1_thread_delegated",
            "This chat runs on V2; write in its V2 conversation",
        ));
    }
    match sidebar_v1::send_input(&broker, &record, &input).await {
        Ok(receipt) if receipt.is_valid() => Ok((
            if receipt.duplicate {
                StatusCode::OK
            } else {
                StatusCode::ACCEPTED
            },
            Json(receipt),
        )
            .into_response()),
        Ok(_) | Err(sidebar_v1::InputFailure::Unknown) => Err(Error(
            StatusCode::GATEWAY_TIMEOUT,
            "v1_receipt_unknown",
            "V1 did not confirm; retry sends the same message once",
        )),
        Err(sidebar_v1::InputFailure::NotFound) => Err(not_listed()),
        Err(sidebar_v1::InputFailure::KeyConflict) => Err(Error(
            StatusCode::CONFLICT,
            "idempotency_conflict",
            "Message key already used for a different message",
        )),
        Err(sidebar_v1::InputFailure::Refused(_)) => Err(Error(
            StatusCode::CONFLICT,
            "v1_refused",
            "V1 refused this message",
        )),
    }
}

#[cfg(test)]
#[path = "sidebar_http_tests.rs"]
mod tests;
