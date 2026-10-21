//! Sidebar badges in one request: the Deep execution status and the window
//! queue of up to 50 listed conversations. Each row is exactly what
//! `GET …/{id}/execution` and `GET …/{id}/window/queue` answer (status and
//! JSON body), so the browser needs one round trip instead of two per
//! conversation every poll. Read-only; never starts or settles work.
use super::*;
use axum::{
    body::to_bytes,
    extract::{rejection::QueryRejection, Path, Query},
};
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
    browser::owner(&state, &headers).await?;
    let Query(query) = query.map_err(|_| invalid())?;
    let ids = parse_ids(&query.ids)?;
    let mut rows = Vec::with_capacity(ids.len());
    for id in ids {
        let execution = row(execution::status(
            State(state.clone()),
            headers.clone(),
            Path(id.clone()),
            Ok(Query(execution::StatusQuery::default())),
        )
        .await)
        .await;
        let queue =
            row(window_http::queue(State(state.clone()), headers.clone(), Path(id.clone())).await)
                .await;
        rows.push(json!({"id": id, "execution": execution, "queue": queue}));
    }
    Ok(Json(json!({"rows": rows})).into_response())
}

#[cfg(test)]
#[path = "conversation_status_http_tests.rs"]
mod tests;
