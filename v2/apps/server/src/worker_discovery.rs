//! Browser-only Worker discovery. Registration belongs to the server composition.
use super::*;
use axum::extract::{rejection::QueryRejection, Path, Query};
use orkestr_v2_application::runtime::RuntimeStoreError;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DiscoveryQuery {
    after: Option<RunId>,
    limit: Option<u32>,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<DiscoveryQuery>, QueryRejection>,
) -> Result<Response, Error> {
    // Authenticate before interpreting locators; machine credentials cannot select
    // a browser principal, and Core rechecks this credential in its read snapshot.
    browser::owner(&state, &headers).await?;
    let credential = browser::credential(&headers)?;
    let Query(query) = query.map_err(|_| invalid_query())?;
    let limit = query.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) || query.after.as_ref().is_some_and(|id| id.0.is_nil()) {
        return Err(invalid_query());
    }
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| invalid_query())?);
    if conversation.0.is_nil() {
        return Err(invalid_query());
    }
    let bound = state.execution_store.as_ref().ok_or_else(unavailable)?;
    let page = bound
        .worker_executions_authenticated(&credential, &conversation, query.after.as_ref(), limit)
        .await
        .map_err(|error| match error {
            RuntimeStoreError::Unauthorized => unauthorized(),
            RuntimeStoreError::NotFound => {
                Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
            }
            RuntimeStoreError::InvalidInput => invalid_query(),
            _ => unavailable(),
        })?;
    if !page.is_valid()
        || page.conversation_id != conversation
        || page.workers.len() > limit as usize
        || query.after.as_ref().is_some_and(|after| {
            page.workers
                .iter()
                .any(|worker| worker.run_id.to_string() <= after.to_string())
        })
    {
        return Err(unavailable());
    }
    let mut response = Json(page).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static header"),
    );
    Ok(response)
}

fn invalid_query() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_query",
        "Invalid Worker discovery query",
    )
}
fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "discovery_unavailable",
        "Worker discovery unavailable",
    )
}

#[cfg(test)]
#[path = "worker_discovery_tests.rs"]
mod tests;
