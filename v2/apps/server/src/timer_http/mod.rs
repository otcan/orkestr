//! Leaf router. Deep owns registration under existing auth/origin/CSRF guard.
mod controller;
pub mod dto;
pub mod durable;
use crate::{AppState, Error};
use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Extension, Json, Router,
};
pub use controller::{Clock, SystemClock, TimerController};
use orkestr_v2_contracts::OwnerId;
use orkestr_v2_store_sqlite::{
    history_import::{
        timers::{
            TimerControl, TimerControlRequest, TimerDetail, TimerEnableRequest, TimerReceipt,
            TimerSchedule, TimerState,
        },
        HistoryError,
    },
    Store,
};
use uuid::Uuid;
// Shared owner policy runs first; this only carries its exact credential into
// Core's transaction-time reauthentication, never a parallel auth decision.
async fn owner_credential(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(OwnerId, String), Error> {
    let owner = crate::owner(state, headers).await?;
    let credential = if headers.contains_key(axum::http::header::COOKIE) {
        crate::browser::credential(headers)?
    } else {
        headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(crate::unauthorized)?
            .to_owned()
    };
    Ok((owner, credential))
}
fn error(e: HistoryError) -> Error {
    match e {
        HistoryError::Unauthorized => crate::unauthorized(),
        HistoryError::Invalid => Error(
            StatusCode::BAD_REQUEST,
            "invalid_timer",
            "Invalid timer request",
        ),
        HistoryError::NotFound => {
            Error(StatusCode::NOT_FOUND, "timer_not_found", "Timer not found")
        }
        HistoryError::Conflict => Error(
            StatusCode::CONFLICT,
            "timer_conflict",
            "Timer revision, generation, Stop boundary or replay conflicts",
        ),
        HistoryError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "timer_unavailable",
            "Timer controller unavailable",
        ),
    }
}
fn namespace(id: String) -> Result<Uuid, Error> {
    Uuid::parse_str(&id)
        .ok()
        .filter(|id| !id.is_nil())
        .ok_or_else(|| error(HistoryError::Invalid))
}
fn body<T>(value: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    value.map(|v| v.0).map_err(|_| error(HistoryError::Invalid))
}
async fn detail(controller: &TimerController, owner: &OwnerId, value: TimerDetail) -> dto::Detail {
    let receipt = value.receipt;
    let armed = controller.armed(owner, &receipt).await;
    dto::Detail {
        namespace: receipt.namespace,
        source_digest: receipt.source_digest,
        schedule: match value.schedule {
            TimerSchedule::Once { due_ms } => dto::Schedule::Once { due_ms },
            TimerSchedule::Interval { every_ms } => dto::Schedule::Interval { every_ms },
            TimerSchedule::UtcClock {
                weekly,
                minute_of_day,
            } => dto::Schedule::UtcClock {
                weekly,
                minute_of_day,
            },
            TimerSchedule::Dormant { .. } => dto::Schedule::Dormant,
        },
        conversation_id: value.conversation_id,
        state: match receipt.state {
            TimerState::Paused => "paused",
            TimerState::Enabled => "enabled",
            TimerState::Disabled => "disabled",
            TimerState::Stopped => "stopped",
            TimerState::RolledBack => "rolled_back",
            TimerState::Exhausted => "exhausted",
        },
        dormant_reason: receipt.dormant_reason,
        revision: receipt.revision,
        generation: receipt.generation,
        next_due_ms: receipt.next_due_ms,
        controller_armed: armed,
        controller_hold: if receipt.state == TimerState::Enabled && !armed {
            Some("explicit_owner_rearm_required")
        } else {
            None
        },
    }
}
async fn read(
    State(s): State<AppState>,
    Extension(c): Extension<TimerController>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<dto::Read>, QueryRejection>,
) -> Result<Json<dto::Detail>, Error> {
    query.map_err(|_| error(HistoryError::Invalid))?;
    let (owner, credential) = owner_credential(&s, &headers).await?;
    let receipt = s
        .store
        .dormant_timer_detail(&credential, &owner, namespace(id)?)
        .await
        .map_err(error)?;
    Ok(Json(detail(&c, &owner, receipt).await))
}
async fn enable(
    State(s): State<AppState>,
    Extension(c): Extension<TimerController>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<dto::Read>, QueryRejection>,
    value: Result<Json<dto::Enable>, JsonRejection>,
) -> Result<Json<dto::Detail>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    query.map_err(|_| error(HistoryError::Invalid))?;
    let receipt = c
        .enable(
            credential.clone(),
            owner.clone(),
            namespace(id)?,
            body(value)?,
        )
        .await
        .map_err(error)?;
    let value = s
        .store
        .dormant_timer_detail(&credential, &owner, receipt.namespace)
        .await
        .map_err(error)?;
    Ok(Json(detail(&c, &owner, value).await))
}
async fn control(
    State(s): State<AppState>,
    Extension(c): Extension<TimerController>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<dto::Read>, QueryRejection>,
    value: Result<Json<dto::Control>, JsonRejection>,
) -> Result<Json<dto::Detail>, Error> {
    let (owner, credential) = owner_credential(&s, &headers).await?;
    query.map_err(|_| error(HistoryError::Invalid))?;
    let namespace = namespace(id)?;
    let body = body(value)?;
    let receipt = s
        .store
        .control_dormant_timer(
            &credential,
            &owner,
            &TimerControlRequest {
                namespace,
                expected_revision: body.expected_revision,
                request_key: body.request_key,
                action: match body.action {
                    dto::Action::Disable => TimerControl::Disable,
                    dto::Action::Stop => TimerControl::Stop,
                    dto::Action::Rollback => TimerControl::Rollback,
                },
            },
        )
        .await
        .map_err(error)?;
    c.disarm(&owner, namespace).await;
    let value = s
        .store
        .dormant_timer_detail(&credential, &owner, receipt.namespace)
        .await
        .map_err(error)?;
    Ok(Json(detail(&c, &owner, value).await))
}
pub fn routes(controller: TimerController) -> Router<AppState> {
    Router::new()
        .route("/api/v2/timers/{namespace}", get(read))
        .route("/api/v2/timers/{namespace}/enable", post(enable))
        .route("/api/v2/timers/{namespace}/control", post(control))
        .layer(Extension(controller))
}

#[cfg(test)]
mod tests;
