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

/// ORK-798: the owner settles one exact automatic result that sits in a
/// closed window and can never run (a lapsed claim, or a finished Fast run).
/// Only the owner's own browser session; the receipt is immutable.
pub(crate) async fn settle_stale(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, input)): Path<(String, String)>,
    body: Result<Json<StaleInputSettlementRequest>, JsonRejection>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "settle_stale_input",
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
        .settle_stale_input_for_browser(&credential, &conversation, &message, &request)
        .await
        .map_err(|error| match error {
            RuntimeStoreError::Unauthorized => unauthorized(),
            RuntimeStoreError::NotFound => {
                Error(StatusCode::NOT_FOUND, "not_found", "Owner input not found")
            }
            RuntimeStoreError::Conflict => Error(
                StatusCode::CONFLICT,
                "stale_input_settlement_conflict",
                "Input is not a stale automatic result in a closed window",
            ),
            RuntimeStoreError::InvalidInput => invalid(),
            _ => Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "stale_input_settlement_unavailable",
                "Stale input settlement unavailable",
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
#[path = "stale_inputs_http_tests.rs"]
mod stale_tests;
#[cfg(test)]
#[path = "retired_inputs_http_tests.rs"]
mod tests;
