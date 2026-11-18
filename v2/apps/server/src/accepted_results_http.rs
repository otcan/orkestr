//! Read-only canonical accepted results, independent of live execution handles.
use super::*;
use axum::extract::{rejection::QueryRejection, Path, Query};
use orkestr_v2_application::runtime::RuntimeStoreError;

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Page {
    after_sequence: Option<i64>,
    limit: Option<u16>,
    /// The newest page below this acceptance sequence instead of a forward
    /// page (`9223372036854775807`: the newest replies, for opening a chat).
    before_sequence: Option<i64>,
}

pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<Page>, QueryRejection>,
) -> Result<Response, Error> {
    // Host/cookie policy applies here even when there is no live supervisor.
    // Core repeats original credential authentication in the projection's read TX.
    browser::owner(&state, &headers).await?;
    let Query(page) = query.map_err(|_| invalid_query())?;
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid conversation ID",
        )
    })?);
    let after = page.after_sequence.unwrap_or(0);
    let limit = page.limit.unwrap_or(20);
    let before = page.before_sequence;
    if conversation.0.is_nil()
        || after < 0
        || !(1..=50).contains(&limit)
        || before.is_some_and(|before| before < 1 || page.after_sequence.is_some())
    {
        return Err(invalid_query());
    }
    let credential = browser::credential(&headers)?;
    let read = match before {
        Some(before) => {
            state
                .store
                .accepted_results_before_authenticated(&credential, &conversation, before, limit)
                .await
        }
        None => {
            state
                .store
                .accepted_results_authenticated(&credential, &conversation, after, limit)
                .await
        }
    };
    let result = read.map_err(|error| match error {
        RuntimeStoreError::Unauthorized => unauthorized(),
        RuntimeStoreError::NotFound => {
            Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
        }
        RuntimeStoreError::InvalidInput => invalid_query(),
        _ => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "history_unavailable",
            "Accepted results unavailable",
        ),
    })?;
    if result.conversation_id != conversation
        || !result.is_valid()
        || result.results.len() > usize::from(limit)
        || result
            .results
            .first()
            .is_some_and(|row| row.acceptance_sequence <= after)
        || before.is_some_and(|before| {
            result.next_after_sequence.is_some()
                || result
                    .results
                    .last()
                    .is_some_and(|row| row.acceptance_sequence >= before)
        })
    {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_projection",
            "Accepted results unavailable",
        ));
    }
    crate::observability::rows(result.results.len());
    Ok(Json(result).into_response())
}

fn invalid_query() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_query",
        "Invalid accepted-results query",
    )
}

#[cfg(test)]
#[path = "accepted_results_http_tests.rs"]
mod tests;
