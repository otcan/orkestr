//! Durable window admission only; a receipt never activates a provider.
use super::*;
use crate::window_runtime::WindowOutcome;
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
    let status = match &state.window_controller {
        Some(controller) => controller.status(&credential, &conversation).await,
        None => {
            state
                .store
                .execution_window_status_authenticated(&credential, &conversation)
                .await
        }
    }
    .map_err(store_error)?;
    match status {
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
    let owner = browser::owner(&state, &headers).await?;
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
    // A restricted thread's model runs only through the broker, never in a window.
    if state
        .store
        .is_restricted_conversation(&conversation)
        .await
        .unwrap_or(true)
    {
        return Err(Error(
            StatusCode::CONFLICT,
            "restricted_conversation",
            "Restricted threads do not use execution windows",
        ));
    }
    // The task owns admission and startup across HTTP disconnect/cancellation.
    // Dropping this join handle does not cancel its durable handoff.
    let outcome = tokio::spawn(async move {
        if let Some(controller) = &state.window_controller {
            controller
                .process(&credential, &owner, &conversation, &input)
                .await
                .map_err(|reason| {
                    // Controller errors are closed static diagnostics, never
                    // raw provider output or a user-supplied path/message.
                    eprintln!("window admission refused: {reason}");
                    Error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "window_unavailable",
                        "Window admission or transport requires reconciliation",
                    )
                })
        } else {
            state
                .store
                .admit_execution_window_authenticated(&credential, &conversation, &input)
                .await
                .map(WindowOutcome::Admitted)
                .map_err(store_error)
        }
    })
    .await
    .map_err(|_| {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "window_unavailable",
            "Window task outcome is uncertain",
        )
    })??;
    Ok(match outcome {
        WindowOutcome::Admitted(admission) => (
            if admission.duplicate {
                StatusCode::OK
            } else {
                StatusCode::CREATED
            },
            Json(admission),
        )
            .into_response(),
        // Durably queued behind live capacity or earlier intents; never started yet.
        WindowOutcome::Queued(queued) => (StatusCode::ACCEPTED, Json(queued)).into_response(),
    })
}

/// Owner-wide capacity and this conversation's durably queued window intents.
pub(crate) async fn queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let credential = browser::credential(&headers)?;
    let conversation = conversation(&id)?;
    let controller = state.window_controller.as_ref().ok_or(Error(
        StatusCode::NOT_FOUND,
        "beta_unconfigured",
        "Beta execution is not configured",
    ))?;
    let queue = controller
        .queue_status(&credential, &conversation)
        .await
        .map_err(store_error)?;
    Ok(Json(queue).into_response())
}

/// Owner decision for a window stranded by a previous process: abandon its
/// unaccepted proposals, or retire it after the owner accepted/stopped them.
pub(crate) async fn reconcile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ExecutionWindowReconciliationRequest>, JsonRejection>,
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
    let Some(controller) = state.window_controller.clone() else {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "window_unavailable",
            "Window runtime is not configured",
        ));
    };
    // Like admission, the decision completes across HTTP disconnect.
    let receipt = tokio::spawn(async move {
        controller
            .reconcile_owner(&credential, &conversation, &input)
            .await
            .map_err(|error| match error {
                window_runtime::ReconcileError::LiveOwner => Error(
                    StatusCode::CONFLICT,
                    "window_live",
                    "The window is still owned by a running task; accept or stop it",
                ),
                window_runtime::ReconcileError::NotFound => Error(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "No such unfinished window",
                ),
                window_runtime::ReconcileError::Refused => Error(
                    StatusCode::CONFLICT,
                    "window_conflict",
                    "Window cannot be reconciled in its current state",
                ),
            })
    })
    .await
    .map_err(|_| {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "window_unavailable",
            "Window reconciliation outcome is uncertain",
        )
    })??;
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

/// No input is admitted by reset. The next separately admitted input selects
/// fresh setup from Core's audited owner decision, never from a resume refusal.
pub(crate) async fn reset_native(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<orkestr_v2_contracts::ClaudeNativeResetRequest>, JsonRejection>,
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
    let Json(request) = body.map_err(|_| invalid())?;
    if !request.is_valid() {
        return Err(invalid());
    }
    let controller = state.window_controller.clone().ok_or(Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "window_unavailable",
        "Window runtime is not configured",
    ))?;
    let receipt = tokio::spawn(async move {
        controller
            .reset_claude_native(&credential, &conversation, &request)
            .await
    })
    .await
    .map_err(|_| {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "window_unavailable",
            "Native reset outcome is uncertain",
        )
    })?
    .map_err(|_| {
        Error(
            StatusCode::CONFLICT,
            "native_reset_conflict",
            "Reconcile and retire the exact window before resetting Claude native continuity",
        )
    })?;
    Ok(Json(receipt).into_response())
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
