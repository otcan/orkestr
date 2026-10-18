//! Explicit owner decision; provider output cannot invoke this authority.
use super::*;
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::ExecutionAcceptanceRequest;

pub(crate) async fn accept(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ExecutionAcceptanceRequest>, JsonRejection>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "execution_accept",
        &headers,
    )
    .await?;
    let credential = browser::credential(&headers)?;
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid conversation ID",
        )
    })?);
    let Json(input) = body.map_err(|_| invalid())?;
    if !input.is_valid() {
        return Err(invalid());
    }
    // The store rechecks this exact credential under its mutation transaction,
    // including historical receipt replay. A cached owner is insufficient.
    let receipt = state
        .store
        .accept_execution_authenticated(&credential, &conversation, &input)
        .await
        .map_err(|error| match error {
            RuntimeStoreError::Unauthorized => unauthorized(),
            RuntimeStoreError::InvalidInput => invalid(),
            RuntimeStoreError::NotFound => {
                Error(StatusCode::NOT_FOUND, "not_found", "Execution not found")
            }
            RuntimeStoreError::Conflict => Error(
                StatusCode::CONFLICT,
                "revision_conflict",
                "Acceptance conflicts with execution state",
            ),
            RuntimeStoreError::Busy
            | RuntimeStoreError::Fenced
            | RuntimeStoreError::StaleLease
            | RuntimeStoreError::Expired => Error(
                StatusCode::CONFLICT,
                "execution_unavailable",
                "Execution cannot be accepted",
            ),
            RuntimeStoreError::Unavailable => unavailable(),
        })?;
    if !receipt.is_valid()
        || receipt.conversation_id != conversation
        || receipt.run_id != input.run_id
        || receipt.completion_event_id != input.completion_event_id
        || receipt.request_key != input.request_key
        || receipt.requested_revision != input.expected_revision
    {
        return Err(unavailable());
    }
    Ok(Json(receipt).into_response())
}
fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_input",
        "Invalid acceptance request",
    )
}
fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "acceptance_unavailable",
        "Acceptance unavailable",
    )
}
