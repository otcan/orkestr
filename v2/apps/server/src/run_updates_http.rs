//! Every interim update of a conversation's Deep runs, in event order:
//! `GET /api/v2/conversations/{id}/updates` with `after_sequence` (forward
//! pages) or `before_sequence` (the newest page below it), `limit` 1..=100.
//! The web chat shows each update as its own message, like WhatsApp; the
//! payload an accepted result names is marked `final_answer` and shown once,
//! as the accepted reply. Read-only; the texts are read like answers.
use super::*;
use axum::extract::{rejection::QueryRejection, Path, Query};
use orkestr_v2_application::runtime::RuntimeStoreError;

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Page {
    after_sequence: Option<i64>,
    before_sequence: Option<i64>,
    limit: Option<u16>,
}

pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<Page>, QueryRejection>,
) -> Result<Response, Error> {
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
    let limit = page.limit.unwrap_or(RUN_UPDATES_PAGE_MAX);
    let before = page.before_sequence;
    if conversation.0.is_nil()
        || after < 0
        || !(1..=RUN_UPDATES_PAGE_MAX).contains(&limit)
        || before.is_some_and(|before| before < 1 || page.after_sequence.is_some())
    {
        return Err(invalid_query());
    }
    let credential = browser::credential(&headers)?;
    let read = match before {
        Some(before) => {
            state
                .store
                .run_updates_before_authenticated(&credential, &conversation, before, limit)
                .await
        }
        None => {
            state
                .store
                .run_updates_authenticated(&credential, &conversation, after, limit)
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
            "Run updates unavailable",
        ),
    })?;
    if result.conversation_id != conversation
        || !result.is_valid()
        || result.updates.len() > usize::from(limit)
        || result.updates.first().is_some_and(|u| u.sequence <= after)
        || before.is_some_and(|before| {
            result.next_after_sequence.is_some()
                || result.updates.last().is_some_and(|u| u.sequence >= before)
        })
    {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_projection",
            "Run updates unavailable",
        ));
    }
    crate::observability::rows(result.updates.len());
    Ok(Json(result).into_response())
}

fn invalid_query() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_query",
        "Invalid run-updates query",
    )
}

#[cfg(test)]
#[path = "run_updates_http_tests.rs"]
mod tests;
