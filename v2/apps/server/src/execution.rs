//! Authenticated execution projection and revision-guarded Stop handoff.
use super::*;
use axum::extract::Path;
use orkestr_v2_application::runtime::RuntimeStoreError;

pub(crate) async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let owner = owner(&state, &headers).await?;
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid conversation ID",
        )
    })?);
    let status = state
        .store
        .execution_status(&owner, &conversation)
        .await
        .map_err(|error| match error {
            RuntimeStoreError::NotFound | RuntimeStoreError::Unauthorized => {
                Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
            }
            _ => Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "store_unavailable",
                "Execution status unavailable",
            ),
        })?;
    match status {
        None => Ok(StatusCode::NO_CONTENT.into_response()),
        Some(mut status) if status.conversation_id == conversation && status.is_valid() => {
            status.capabilities.stop = status.phase == ExecutionPhase::Running
                && state.execution_control.as_ref().is_some_and(|control| {
                    status
                        .run_id
                        .as_ref()
                        .is_some_and(|run| control.available(&owner, &conversation, run))
                });
            Ok(Json(status).into_response())
        }
        Some(_) => Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_projection",
            "Execution status unavailable",
        )),
    }
}

/// Browser-only durable intent. A receipt is never provider interruption proof.
pub(crate) async fn stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<
        Json<orkestr_v2_contracts::ExecutionControlRequest>,
        axum::extract::rejection::JsonRejection,
    >,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "execution_stop",
        &headers,
    )
    .await?;
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid conversation ID",
        )
    })?);
    let Json(input) = body.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Invalid Stop request",
        )
    })?;
    if !input.is_valid() {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Invalid Stop request",
        ));
    }
    let store = state.execution_store.as_ref().ok_or(Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "control_unavailable",
        "Stop unavailable",
    ))?;
    let credential = browser::credential(&headers)?;
    let requested = match &state.execution_control {
        Some(control) => Some(control.request(&owner, &conversation, &input).ok_or(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "control_unavailable",
            "Stop unavailable",
        ))?),
        None => None,
    };
    let _schedule = match &requested {
        Some(control) => Some(control.serialize().await),
        None => None,
    };
    // Selection is not authority. The exact owned run may have retired while
    // this request waited for its bounded native step to release the lock.
    if requested
        .as_ref()
        .is_some_and(|control| !control.is_permitted())
    {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "control_unavailable",
            "Stop unavailable",
        ));
    }
    let (receipt, issued_control) = store
        .stop_execution_control_authenticated(&credential, &conversation, &input)
        .await
        .map_err(stop_error)?;
    if !receipt.is_valid()
        || receipt.conversation_id != conversation
        || receipt.run_id != input.run_id
        || receipt.request_key != input.request_key
        || receipt.requested_revision != input.expected_revision
    {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_receipt",
            "Stop unavailable",
        ));
    }
    if let Some(control) = requested {
        control.publish(issued_control).map_err(|_| {
            Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "control_unavailable",
                "Stop delivery requires reconciliation",
            )
        })?;
    }
    Ok(Json(receipt).into_response())
}
fn stop_error(error: RuntimeStoreError) -> Error {
    match error {
        RuntimeStoreError::InvalidInput => Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Invalid Stop request",
        ),
        RuntimeStoreError::Unauthorized => unauthorized(),
        RuntimeStoreError::NotFound => {
            Error(StatusCode::NOT_FOUND, "not_found", "Execution not found")
        }
        RuntimeStoreError::Conflict => Error(
            StatusCode::CONFLICT,
            "revision_conflict",
            "Stop request conflicts with execution state",
        ),
        RuntimeStoreError::Fenced | RuntimeStoreError::StaleLease | RuntimeStoreError::Expired => {
            Error(
                StatusCode::CONFLICT,
                "execution_fenced",
                "Execution authority changed",
            )
        }
        RuntimeStoreError::Busy => {
            Error(StatusCode::CONFLICT, "execution_busy", "Execution is busy")
        }
        RuntimeStoreError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "control_unavailable",
            "Stop unavailable",
        ),
    }
}
