//! Durable window admission only; a receipt never activates a provider.
use super::*;
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_application::runtime::RuntimeStoreError;

pub(crate) async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let credential = browser::credential(&headers)?;
    let conversation = conversation(&id)?;
    match state
        .store
        .execution_window_status_authenticated(&credential, &conversation)
        .await
        .map_err(store_error)?
    {
        Some(status) => Ok(Json(status).into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

pub(crate) async fn admit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ExecutionWindowRequest>, JsonRejection>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "execution_window",
        &headers,
    )
    .await?;
    let credential = browser::credential(&headers)?;
    let conversation = conversation(&id)?;
    let Json(input) = body.map_err(|_| invalid())?;
    if !input.is_valid() {
        return Err(invalid());
    }
    let admission = state
        .store
        .admit_execution_window_authenticated(&credential, &conversation, &input)
        .await
        .map_err(store_error)?;
    Ok((
        if admission.duplicate {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(admission),
    )
        .into_response())
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
        "invalid_input",
        "Invalid window request",
    )
}
fn store_error(error: RuntimeStoreError) -> Error {
    match error {
        RuntimeStoreError::Unauthorized => unauthorized(),
        RuntimeStoreError::InvalidInput => invalid(),
        RuntimeStoreError::NotFound => {
            Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
        }
        RuntimeStoreError::Conflict
        | RuntimeStoreError::Fenced
        | RuntimeStoreError::StaleLease
        | RuntimeStoreError::Expired => Error(
            StatusCode::CONFLICT,
            "window_conflict",
            "Window admission conflicts with current state",
        ),
        RuntimeStoreError::Busy | RuntimeStoreError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "window_unavailable",
            "Window unavailable",
        ),
    }
}
