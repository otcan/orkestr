//! Owner-authenticated archived legacy history. Import is display-only
//! provenance: it never admits input, starts execution or replays effects.
use super::*;
use axum::extract::{
    rejection::{JsonRejection, QueryRejection},
    DefaultBodyLimit, Path, Query,
};
use orkestr_v2_store_sqlite::HistoryError;

/// Serialized batches stay below this; the store bounds message count/text.
pub(crate) const ARCHIVED_REQUEST_MAX: usize = 8 * 1024 * 1024;

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Page {
    after: Option<i64>,
    limit: Option<u32>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v2/conversations/{id}/archived-history",
            get(read).post(import),
        )
        .route(
            "/api/v2/conversations/{id}/archived-history/status",
            get(status),
        )
        .layer(DefaultBodyLimit::max(ARCHIVED_REQUEST_MAX))
}

/// Shared owner policy first; the exact credential is re-checked by Core.
pub(crate) async fn owner_credential(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(OwnerId, String), Error> {
    let owner = crate::owner(state, headers).await?;
    let credential = if headers.contains_key(header::COOKIE) {
        browser::credential(headers)?
    } else {
        let mut values = headers.get_all(header::AUTHORIZATION).iter();
        let token = values
            .next()
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(unauthorized)?;
        if values.next().is_some() {
            return Err(unauthorized());
        }
        token.to_owned()
    };
    Ok((owner, credential))
}
fn conversation(id: &str) -> Result<ConversationId, Error> {
    Uuid::parse_str(id)
        .ok()
        .filter(|id| !id.is_nil())
        .map(ConversationId)
        .ok_or_else(invalid)
}
fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_archive",
        "Invalid archived history request",
    )
}
fn failure(error: HistoryError) -> Error {
    match error {
        HistoryError::Invalid => invalid(),
        HistoryError::Unauthorized => unauthorized(),
        HistoryError::NotFound => {
            Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
        }
        HistoryError::Conflict => Error(
            StatusCode::CONFLICT,
            "archive_conflict",
            "Archived history failed verification",
        ),
        HistoryError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Archived history unavailable",
        ),
    }
}

pub(crate) async fn import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ArchivedImportRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let Json(request) = body.map_err(|_| invalid())?;
    let receipt = state
        .store
        .import_archived_history(&credential, &owner, &conversation, &request)
        .await
        .map_err(failure)?;
    Ok(Json(receipt).into_response())
}

pub(crate) async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let result = state
        .store
        .archived_history_status(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(result).into_response())
}

pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<Page>, QueryRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Query(page) = query.map_err(|_| invalid())?;
    let result = state
        .store
        .archived_history_page(
            &credential,
            &owner,
            &conversation(&id)?,
            page.after.unwrap_or(0),
            page.limit.unwrap_or(50),
        )
        .await
        .map_err(failure)?;
    Ok(Json(result).into_response())
}

#[cfg(test)]
#[path = "archived_history_http_tests.rs"]
mod tests;
