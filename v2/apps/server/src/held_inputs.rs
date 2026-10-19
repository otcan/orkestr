//! Read-only provenance for owner input held at a committed Deep Stop boundary.
use super::*;
use axum::extract::{rejection::QueryRejection, Path, Query};
use orkestr_v2_application::runtime::RuntimeStoreError;

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Page {
    after_sequence: Option<i64>,
    limit: Option<u32>,
}

pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<Page>, QueryRejection>,
) -> Result<Response, Error> {
    // Browser auth is checked again by Core in the same snapshot as this read.
    // There is no route here to release, delete or turn a hold into authority.
    browser::owner(&state, &headers).await?;
    let Query(page) = query.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "Invalid held-input query",
        )
    })?;
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid conversation ID",
        )
    })?);
    let after = page.after_sequence.unwrap_or(0);
    let limit = page.limit.unwrap_or(50);
    if conversation.0.is_nil() || after < 0 || !(1..=100).contains(&limit) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "Invalid held-input query",
        ));
    }
    let credential = browser::credential(&headers)?;
    // A hold outlives its originating execution scope. Read through the durable
    // owner store; Core reauthenticates this browser in the same read snapshot.
    let page = state
        .store
        .held_owner_inputs_for_browser(&credential, &conversation, after, limit)
        .await
        .map_err(|error| match error {
            RuntimeStoreError::Unauthorized => unauthorized(),
            RuntimeStoreError::NotFound => {
                Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
            }
            RuntimeStoreError::InvalidInput => Error(
                StatusCode::BAD_REQUEST,
                "invalid_query",
                "Invalid held-input query",
            ),
            _ => Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "status_unavailable",
                "Held input status unavailable",
            ),
        })?;
    if page.conversation_id != conversation
        || !page.is_valid()
        || page.held.len() > limit as usize
        || page
            .held
            .first()
            .is_some_and(|row| row.scope_sequence <= after)
    {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_projection",
            "Held input status unavailable",
        ));
    }
    Ok(Json(page).into_response())
}

#[cfg(test)]
#[path = "held_inputs_http_tests.rs"]
mod tests;
