//! An authenticated owner can retire an exact unstarted input without execution.
use super::*;
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_application::runtime::RuntimeStoreError;

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_input_retirement",
        "Invalid owner input retirement",
    )
}

pub(crate) async fn retire(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, input)): Path<(String, String)>,
    body: Result<Json<OwnerInputRetirementRequest>, JsonRejection>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "retire_owner_input",
        &headers,
    )
    .await?;
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| invalid())?);
    let message = MessageId(Uuid::parse_str(&input).map_err(|_| invalid())?);
    let Json(request) = body.map_err(|_| invalid())?;
    if conversation.0.is_nil() || message.0.is_nil() || !request.is_valid() {
        return Err(invalid());
    }
    let credential = browser::credential(&headers)?;
    let receipt = state
        .store
        .retire_owner_input_for_browser(&credential, &conversation, &message, &request)
        .await
        .map_err(|error| match error {
            RuntimeStoreError::Unauthorized => unauthorized(),
            RuntimeStoreError::NotFound => {
                Error(StatusCode::NOT_FOUND, "not_found", "Owner input not found")
            }
            RuntimeStoreError::Conflict => Error(
                StatusCode::CONFLICT,
                "input_retirement_conflict",
                "Input is already claimed, admitted, queued for execution or retired",
            ),
            RuntimeStoreError::InvalidInput => invalid(),
            _ => Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "input_retirement_unavailable",
                "Input retirement unavailable",
            ),
        })?;
    Ok((
        if receipt.duplicate {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(receipt),
    )
        .into_response())
}

#[cfg(test)]
#[path = "retired_inputs_http_tests.rs"]
mod tests;
