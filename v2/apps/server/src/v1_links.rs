//! Old V1 deep links (`/instance/ins_…/thread/thr_…`) in the Rust UI. The page
//! route only redirects to a UI fragment; the owner-authenticated lookup maps
//! the V1 public reference to the V2 conversation of a migrated thread, or to
//! the linked V1 entry of a thread that is still on V1. Nothing else resolves.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::sidebar_v1;
use axum::extract::{rejection::QueryRejection, Path, Query};
use std::collections::HashMap;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/instance/{instance}/thread/{thread}", get(redirect))
        .route("/instance/{instance}/thread/{thread}/", get(redirect))
        .route("/api/v2/v1-links/{thread}", get(resolve))
}

fn not_found() -> Error {
    Error(StatusCode::NOT_FOUND, "not_found", "Link not found")
}

/// `303` to `/#v1-link/<ins>/<thr>`: the UI resolves it after sign-in.
/// Malformed references are a plain 404, never a redirect.
pub(crate) async fn redirect(Path((instance, thread)): Path<(String, String)>) -> Response {
    if !valid_v1_instance_ref(&instance) || !valid_v1_thread_ref(&thread) {
        return StatusCode::NOT_FOUND.into_response();
    }
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, format!("/#v1-link/{instance}/{thread}")),
            (header::CACHE_CONTROL, "no-store".to_owned()),
        ],
    )
        .into_response()
}

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LinkQuery {
    instance: Option<String>,
}

/// Where a V1 deep link opens: the conversation of a migrated (imported)
/// thread first, otherwise the linked V1 entry when the sidebar lists it.
pub(crate) fn target(
    threads: &[sidebar_v1::V1Thread],
    conversations: &HashMap<String, ConversationId>,
    thread_ref: &str,
    instance: Option<&str>,
) -> Option<V1LinkTarget> {
    let thread = threads
        .iter()
        .find(|t| t.public_ref.as_deref() == Some(thread_ref))?;
    if let (Some(asked), Some(actual)) = (instance, thread.instance_ref.as_deref()) {
        if asked != actual {
            return None;
        }
    }
    if let Some(conversation_id) = conversations.get(&thread.id) {
        return Some(V1LinkTarget::Conversation {
            conversation_id: conversation_id.clone(),
        });
    }
    sidebar_v1::listed(threads, &|id| conversations.contains_key(id))
        .into_iter()
        .any(|t| t.id == thread.id)
        .then(|| V1LinkTarget::V1Thread {
            thread_id: thread.id.clone(),
        })
}

pub(crate) async fn resolve(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
    query: Result<Query<LinkQuery>, QueryRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Query(query) = query.map_err(|_| not_found())?;
    if !valid_v1_thread_ref(&thread)
        || query
            .instance
            .as_deref()
            .is_some_and(|i| !valid_v1_instance_ref(i))
    {
        return Err(not_found());
    }
    let broker = state.desktop_broker.clone().ok_or_else(not_found)?;
    let list = state
        .store
        .sidebar_conversations(&credential, &owner)
        .await
        .map_err(|_| {
            Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "sidebar_unavailable",
                "Conversation sidebar unavailable",
            )
        })?;
    let conversations: HashMap<String, ConversationId> = list
        .conversations
        .iter()
        .filter_map(|c| {
            let source = c
                .lineage
                .as_ref()
                .map(|l| l.source_thread_id.clone())
                .or_else(|| c.source_thread_id.clone())?;
            Some((source, c.conversation_id.clone()))
        })
        .collect();
    let threads = state.sidebar_v1.registry(&broker).await.ok_or(Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "v1_unavailable",
        "V1 is not reachable",
    ))?;
    let found = target(&threads, &conversations, &thread, query.instance.as_deref())
        .filter(V1LinkTarget::is_valid)
        .ok_or_else(not_found)?;
    Ok(Json(found).into_response())
}

#[cfg(test)]
#[path = "v1_links_tests.rs"]
mod tests;
