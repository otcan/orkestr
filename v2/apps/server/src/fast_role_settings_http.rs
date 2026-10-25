//! Fast-only owner preferences; no input admission or execution is triggered.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::{conversation, failure, invalid};
use axum::extract::{rejection::JsonRejection, Path};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v2/conversations/{id}/fast/settings",
            get(read).put(update),
        )
        .layer(DefaultBodyLimit::max(4096))
}
async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .fast_role_settings(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<FastRoleSettingsUpdate>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Json(request) = request.map_err(|_| invalid())?;
    let value = state
        .store
        .update_fast_role_settings(&credential, &owner, &conversation(&id)?, &request)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
#[cfg(test)]
#[path = "fast_role_settings_http_tests.rs"]
mod tests;
