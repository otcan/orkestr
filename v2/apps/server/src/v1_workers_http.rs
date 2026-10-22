//! V1 worker sub-threads of a conversation's linked V1 thread, for its Work
//! tab. Reads the sidebar's cached V1 registry (15 s freshness) and its cached
//! previews only: no V1 read beyond the registry refresh the sidebar already
//! does, and nothing here admits input or starts work.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::sidebar_v1::{self, V1Thread};
use axum::extract::Path;
use orkestr_v2_contracts::{
    SidebarPreview, SidebarV1Status, V1WorkerEntry, V1WorkerState, V1WorkersPage, V1_WORKERS_DEPTH,
    V1_WORKERS_MAX, V1_WORKER_NAME_MAX,
};
use std::collections::{HashMap, HashSet};

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/v2/conversations/{id}/v1-workers", get(read))
}

/// One worker found under the linked thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Found<'a> {
    pub thread: &'a V1Thread,
    pub parent: String,
    pub depth: u32,
}

/// The parent of every registry thread: V1 `parentThreadId`, else the parent
/// a `worker-<parent>-<suffix>` id encodes (when that parent is known).
fn parents(threads: &[V1Thread]) -> HashMap<&str, String> {
    let known: HashSet<&str> = threads.iter().map(|t| t.id.as_str()).collect();
    threads
        .iter()
        .filter_map(|t| {
            let parent = t
                .parent
                .clone()
                .or_else(|| sidebar_v1::encoded_parent(&t.id, &|p| known.contains(p)))
                .filter(|p| *p != t.id)?;
            Some((t.id.as_str(), parent))
        })
        .collect()
}

/// Descendants of `root` (breadth first, at most `V1_WORKERS_DEPTH` levels),
/// never task agents and never `root` itself, each once even if V1 parents
/// form a cycle.
pub(crate) fn descendants<'a>(threads: &'a [V1Thread], root: &str) -> Vec<Found<'a>> {
    let parents = parents(threads);
    let mut children: HashMap<&str, Vec<&'a V1Thread>> = HashMap::new();
    for thread in threads {
        if thread.kind.as_deref() == Some("task-agent") {
            continue;
        }
        if let Some(parent) = parents.get(thread.id.as_str()) {
            children.entry(parent.as_str()).or_default().push(thread);
        }
    }
    let mut seen: HashSet<&str> = HashSet::from([root]);
    let mut level: Vec<&str> = vec![root];
    let mut out = Vec::new();
    for depth in 1..=V1_WORKERS_DEPTH {
        let mut next = Vec::new();
        for parent in level {
            for child in children.get(parent).into_iter().flatten() {
                if seen.insert(child.id.as_str()) {
                    out.push(Found {
                        thread: child,
                        parent: parent.to_owned(),
                        depth,
                    });
                    next.push(child.id.as_str());
                }
            }
        }
        if next.is_empty() {
            break;
        }
        level = next;
    }
    out
}

/// The V1 thread whose binding delegates its runtime to this conversation
/// (V1 `remoteThreadId`), for a conversation without a stored V1 link.
pub(crate) fn delegated_thread<'a>(
    threads: &'a [V1Thread],
    conversation: &ConversationId,
) -> Option<&'a str> {
    threads
        .iter()
        .filter(|t| !t.retired)
        .find(|t| {
            t.delegated_to
                .as_deref()
                .and_then(|id| Uuid::parse_str(id).ok())
                == Some(conversation.0)
        })
        .map(|t| t.id.as_str())
}

fn name(thread: &V1Thread) -> String {
    let shown = sidebar_v1::display(&thread.name, V1_WORKER_NAME_MAX);
    if shown.is_empty() {
        thread.id.chars().take(V1_WORKER_NAME_MAX).collect()
    } else {
        shown
    }
}

/// Inputs to [`page`] besides the registry, all read before.
pub(crate) struct Context<'a> {
    pub conversation: ConversationId,
    pub linked: Option<&'a str>,
    pub status: SidebarV1Status,
    /// V1 thread -> the V2 conversation it was imported into.
    pub imported: &'a HashMap<String, ConversationId>,
    pub previews: &'a HashMap<String, SidebarPreview>,
    pub observed_at_ms: i64,
}

/// Build the page. Pure: active workers newest first, then retired ones;
/// cut at `V1_WORKERS_MAX`.
pub(crate) fn page(threads: &[V1Thread], context: Context<'_>) -> V1WorkersPage {
    let (mut workers, mut retired) = (Vec::new(), 0u32);
    if let Some(root) = context.linked {
        let listed: HashSet<&str> =
            sidebar_v1::listed(threads, &|id| context.imported.contains_key(id))
                .into_iter()
                .map(|t| t.id.as_str())
                .collect();
        let mut found = descendants(threads, root);
        found.sort_by(|a, b| {
            a.thread
                .retired
                .cmp(&b.thread.retired)
                .then_with(|| b.thread.last_activity_ms.cmp(&a.thread.last_activity_ms))
                .then_with(|| a.thread.id.cmp(&b.thread.id))
        });
        retired = found.iter().filter(|f| f.thread.retired).count() as u32;
        workers = found
            .into_iter()
            .map(|f| V1WorkerEntry {
                thread_id: f.thread.id.clone(),
                name: name(f.thread),
                parent_thread_id: f.parent,
                depth: f.depth,
                state: if f.thread.retired {
                    V1WorkerState::Retired
                } else if f.thread.working {
                    V1WorkerState::Working
                } else {
                    V1WorkerState::Idle
                },
                last_activity_ms: f.thread.last_activity_ms,
                preview: context.previews.get(&f.thread.id).cloned(),
                openable: listed.contains(f.thread.id.as_str()),
                conversation_id: context.imported.get(&f.thread.id).cloned(),
            })
            .collect();
    }
    let truncated = workers.len() > V1_WORKERS_MAX;
    workers.truncate(V1_WORKERS_MAX);
    V1WorkersPage {
        schema_version: 1,
        observed_at_ms: context.observed_at_ms,
        conversation_id: context.conversation,
        v1_thread_id: context.linked.map(str::to_owned),
        v1_status: context.status,
        workers,
        retired,
        truncated,
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

pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = Uuid::parse_str(&id)
        .ok()
        .filter(|id| !id.is_nil())
        .map(ConversationId)
        .ok_or(Error(
            StatusCode::BAD_REQUEST,
            "invalid_conversation",
            "Invalid conversation id",
        ))?;
    let unavailable = || {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "v1_workers_unavailable",
            "V1 workers unavailable",
        )
    };
    let links = state
        .store
        .conversation_v1_links(&credential, &owner)
        .await
        .map_err(|error| match error {
            orkestr_v2_store_sqlite::ResourceError::Unauthorized => unauthorized(),
            _ => unavailable(),
        })?;
    let (_, linked) = links.iter().find(|(c, _)| *c == conversation).ok_or(Error(
        StatusCode::NOT_FOUND,
        "not_found",
        "Conversation not found",
    ))?;
    let stored = linked.clone().filter(|t| valid_v1_thread_id(t));
    let imported: HashMap<String, ConversationId> = links
        .iter()
        .filter_map(|(c, t)| Some((t.clone().filter(|t| valid_v1_thread_id(t))?, c.clone())))
        .collect();
    let (status, threads) = match &state.desktop_broker {
        None => (SidebarV1Status::Unconfigured, None),
        Some(broker) => match state.sidebar_v1.registry(broker).await {
            Some(threads) => (SidebarV1Status::Ready, Some(threads)),
            None => (SidebarV1Status::Unavailable, None),
        },
    };
    let threads: &[V1Thread] = threads.as_deref().map_or(&[], Vec::as_slice);
    let linked = stored
        .as_deref()
        .or_else(|| delegated_thread(threads, &conversation));
    let found = linked
        .map(|root| descendants(threads, root))
        .unwrap_or_default();
    let previews = state
        .sidebar_v1
        .cached_previews(found.iter().map(|f| f.thread.id.as_str()));
    let page = page(
        threads,
        Context {
            conversation,
            linked,
            status,
            imported: &imported,
            previews: &previews,
            observed_at_ms: now_ms(),
        },
    );
    if !page.is_valid() {
        return Err(unavailable());
    }
    Ok(Json(page).into_response())
}

#[cfg(test)]
#[path = "v1_workers_http_tests.rs"]
mod tests;
