//! `GET /api/v2/local-files/waiting` (ORK-804): the owner's conversations
//! whose agent queued a local folder write that waits for the owner's Allow
//! in the browser tab serving the folder. Every tab and device of the owner
//! polls it, so a write never waits unseen in a tab the owner is not looking
//! at. Owner credential (browser cookie, machine bearer or the owner's live
//! service credential); read-only.
use super::*;
use crate::archived_history_http::owner_credential;
use orkestr_v2_store_sqlite::ResourceError;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/v2/local-files/waiting", get(waiting))
}

fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "store_unavailable",
        "Storage unavailable",
    )
}

async fn waiting(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .local_file_writes_waiting(&credential, &owner)
        .await
        .map_err(|error| match error {
            ResourceError::Unauthorized => unauthorized(),
            _ => unavailable(),
        })?;
    if !value.is_valid() {
        return Err(unavailable());
    }
    Ok(Json(value).into_response())
}

#[cfg(test)]
#[path = "local_files_waiting_http_tests.rs"]
mod tests;
