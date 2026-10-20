//! Owner-authenticated conversation settings (V1 thread controls parity) and
//! V1 worker sub-thread links. Neither admits input nor starts execution.
use super::*;
use crate::archived_history_http::owner_credential;
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_store_sqlite::ResourceError;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v2/conversations/{id}/settings",
            get(settings).put(update_settings),
        )
        .route("/api/v2/conversations/{id}/settings/render", post(render))
        .route(
            "/api/v2/conversations/{id}/legacy-workers",
            get(workers).post(register_workers),
        )
        .route(
            "/api/v2/conversations/{id}/legacy-workers/transition",
            post(transition_worker),
        )
        .layer(DefaultBodyLimit::max(512 * 1024))
}

pub(crate) fn conversation(id: &str) -> Result<ConversationId, Error> {
    Uuid::parse_str(id)
        .ok()
        .filter(|id| !id.is_nil())
        .map(ConversationId)
        .ok_or_else(invalid)
}
pub(crate) fn invalid() -> Error {
    Error(StatusCode::BAD_REQUEST, "invalid_input", "Invalid request")
}
pub(crate) fn failure(error: ResourceError) -> Error {
    match error {
        ResourceError::Invalid => invalid(),
        ResourceError::Unauthorized => unauthorized(),
        ResourceError::NotFound => Error(StatusCode::NOT_FOUND, "not_found", "Not found"),
        ResourceError::Conflict(code) => Error(StatusCode::CONFLICT, code, "Precondition refused"),
        ResourceError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Storage unavailable",
        ),
    }
}
fn body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    body.map(|Json(v)| v).map_err(|_| invalid())
}

async fn settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .conversation_settings(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn update_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<ConversationSettingsUpdate>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let request = body(request)?;
    // Like V1 `orkestr switch`, selecting a provider this installation cannot
    // start is refused instead of silently running the turn on another one.
    if request.provider == ConversationProvider::Claude && !state.claude_turns {
        return Err(Error(
            StatusCode::CONFLICT,
            "provider_unavailable",
            "Claude turns are not installed for this conversation",
        ));
    }
    let value = state
        .store
        .update_conversation_settings(&credential, &owner, &conversation, &request)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

/// Canonical NO_REPLY/prefix/footer rendering for adapters that deliver
/// final answers (e.g. the V1 WhatsApp transport during the parallel run).
async fn render(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<RenderReplyRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let request = body(request)?;
    if request.text.len() > SETTINGS_RENDER_MAX {
        return Err(invalid());
    }
    let settings = state
        .store
        .conversation_settings(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(RenderReplyResponse {
        settings_revision: settings.revision,
        reply: settings.render_reply(&request.text),
    })
    .into_response())
}

async fn workers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .legacy_workers(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn register_workers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<LegacyWorkerRegisterRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let value = state
        .store
        .register_legacy_workers(&credential, &owner, &conversation, &body(request)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn transition_worker(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<LegacyWorkerTransition>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let value = state
        .store
        .transition_legacy_worker(&credential, &owner, &conversation, &body(request)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

#[cfg(test)]
#[path = "conversation_resources_http_tests.rs"]
pub(crate) mod tests;
