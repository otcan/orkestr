//! Sidebar badges in one request: the Deep execution status and the window
//! queue of up to 50 listed conversations. Each row is exactly what
//! `GET …/{id}/execution` and `GET …/{id}/window/queue` answer (status and
//! JSON body), so the browser needs one round trip instead of two per
//! conversation every poll. Read-only; never starts or settles work.
use super::*;
use axum::{
    body::to_bytes,
    extract::{rejection::QueryRejection, Query},
};
use orkestr_v2_application::runtime::RuntimeStoreError;
use serde_json::{json, Value};

/// Same bound as the browser poller.
const MAX_IDS: usize = 50;
/// Each single-conversation body is small; the browser allows 64 KiB.
const BODY_MAX: usize = 64 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/v2/conversation-status", get(read))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Ids {
    ids: String,
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_conversation_list",
        "Invalid conversation list",
    )
}

/// Comma-separated, unique, lowercase-normalized conversation ids.
pub(crate) fn parse_ids(raw: &str) -> Result<Vec<String>, Error> {
    let mut ids: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let id = Uuid::parse_str(part.trim())
            .ok()
            .filter(|id| !id.is_nil() && part.trim().len() == 36)
            .ok_or_else(invalid)?
            .to_string();
        if ids.contains(&id) {
            return Err(invalid());
        }
        ids.push(id);
    }
    if ids.is_empty() || ids.len() > MAX_IDS {
        return Err(invalid());
    }
    Ok(ids)
}

async fn row(result: Result<Response, Error>) -> Value {
    let response = match result {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };
    let status = response.status().as_u16();
    let body = match to_bytes(response.into_body(), BODY_MAX).await {
        Ok(bytes) if !bytes.is_empty() => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    json!({"status": status, "body": body})
}

pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<Ids>, QueryRejection>,
) -> Result<Response, Error> {
    // One authentication failure answers the whole request.
    let owner = browser::owner(&state, &headers).await?;
    let credential = browser::credential(&headers)?;
    let Query(query) = query.map_err(|_| invalid())?;
    let ids = parse_ids(&query.ids)?;
    let conversations: Vec<_> = ids
        .iter()
        .map(|id| ConversationId(Uuid::parse_str(id).expect("validated UUID")))
        .collect();
    let snapshots = state
        .store
        .conversation_statuses_authenticated(
            &credential,
            &owner,
            &conversations,
            state.window_controller.is_some(),
        )
        .await
        .map_err(|error| match error {
            RuntimeStoreError::Unauthorized => unauthorized(),
            _ => Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "store_unavailable",
                "Execution status unavailable",
            ),
        })?;
    let capacity = state
        .window_controller
        .as_ref()
        .filter(|_| snapshots.iter().any(|row| matches!(row.queue, Some(Ok(_)))))
        .map(|controller| controller.queue_snapshot_capacity(&credential));
    let mut rows = Vec::with_capacity(snapshots.len());
    for snapshot in snapshots {
        let conversation = snapshot.conversation_id;
        let execution = snapshot
            .execution
            .map_err(|error| match error {
                RuntimeStoreError::NotFound | RuntimeStoreError::Unauthorized => {
                    Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
                }
                _ => Error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "store_unavailable",
                    "Execution status unavailable",
                ),
            })
            .and_then(|status| {
                execution::current_status(
                    &owner,
                    &conversation,
                    state
                        .registered_execution_scope(&owner, &conversation)
                        .as_ref(),
                    status,
                )
            });
        let queue = match (snapshot.queue, capacity) {
            (Some(result), Some(capacity)) => {
                result.map_err(window_http::store_error).map(|queue| {
                    Json(orkestr_v2_contracts::ExecutionWindowQueue {
                        conversation_id: conversation.clone(),
                        capacity,
                        active: queue.active,
                        queued_total: queue.queued_total,
                        entries: queue.entries,
                    })
                    .into_response()
                })
            }
            (Some(Err(error)), None) => Err(window_http::store_error(error)),
            (None, _) => Err(Error(
                StatusCode::NOT_FOUND,
                "beta_unconfigured",
                "Beta execution is not configured",
            )),
            _ => Err(Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "window_unavailable",
                "Window unavailable",
            )),
        };
        rows.push(json!({"id": conversation, "execution": row(execution).await, "queue": row(queue).await}));
    }
    Ok(Json(json!({"rows": rows})).into_response())
}

#[cfg(test)]
#[path = "conversation_status_http_tests.rs"]
mod tests;
