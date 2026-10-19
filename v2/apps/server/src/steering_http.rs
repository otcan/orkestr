//! Authenticated durable input, with explicit queued/unknown delivery states.
use super::*;
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::ExecutionSteeringRequest;
use orkestr_v2_store_sqlite::SteeringConsumption;

pub(crate) async fn submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ExecutionSteeringRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "execution_steer",
        &headers,
    )
    .await?;
    let conversation = conversation(&id)?;
    let Json(input) = body.map_err(|_| invalid())?;
    if !input.is_valid() {
        return Err(invalid());
    }
    let scope = state
        .execution_scope(&owner, &conversation)
        .await?
        .ok_or_else(unavailable)?;
    let credential = browser::credential(&headers)?;
    let selected = scope
        .control
        .as_ref()
        .and_then(|control| control.select_steering(&owner, &conversation, &input.control.run_id));
    let _schedule = match &selected {
        Some(selected) => Some(selected.serialize().await),
        None => None,
    };
    let held_authority = match &selected {
        Some(selected) => selected.authority().await,
        None => None,
    };
    let authority = held_authority.as_deref().and_then(|issuer| issuer.as_ref());
    let (receipt, reservation) = scope
        .store
        .steer_execution_authenticated(&credential, &conversation, &input, authority)
        .await
        .map_err(store_error)?;
    if let Some(reservation) = reservation {
        // Commit DeliveryUnknown before moving the one-use value to the owned
        // run. A lost HTTP response, closed mailbox or restart cannot replay it.
        let delivery = match scope
            .store
            .consume_codex_steering(reservation)
            .await
            .map_err(store_error)?
        {
            SteeringConsumption::Deliver(delivery) => delivery,
            SteeringConsumption::ReconciliationRequired => return Err(unavailable()),
        };
        selected
            .as_ref()
            .ok_or_else(unavailable)?
            .publish(delivery, authority.ok_or_else(unavailable)?)
            .map_err(|_| unavailable())?;
    }
    Ok(Json(receipt).into_response())
}

pub(crate) async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, key)): Path<(String, String)>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let scope = state
        .execution_scope(&owner, &conversation)
        .await?
        .ok_or_else(unavailable)?;
    let credential = browser::credential(&headers)?;
    let status = scope
        .store
        .steering_status_authenticated(&credential, &conversation, &key)
        .await
        .map_err(store_error)?
        .ok_or(Error(
            StatusCode::NOT_FOUND,
            "not_found",
            "Steering request not found",
        ))?;
    Ok(Json(status).into_response())
}
fn conversation(id: &str) -> Result<ConversationId, Error> {
    Uuid::parse_str(id)
        .map(ConversationId)
        .map_err(|_| invalid())
}
fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_input",
        "Invalid steering request",
    )
}
fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "steering_unavailable",
        "Steering delivery unavailable; inspect the saved request",
    )
}
fn store_error(error: RuntimeStoreError) -> Error {
    match error {
        RuntimeStoreError::InvalidInput => invalid(),
        RuntimeStoreError::Unauthorized => unauthorized(),
        RuntimeStoreError::NotFound => {
            Error(StatusCode::NOT_FOUND, "not_found", "Execution not found")
        }
        RuntimeStoreError::Conflict => Error(
            StatusCode::CONFLICT,
            "revision_conflict",
            "Steering request conflicts with execution state",
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
        RuntimeStoreError::Unavailable => unavailable(),
    }
}
