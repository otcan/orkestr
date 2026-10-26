//! Agent-facing timers of one conversation (TASK-52).
//!
//! Owner (browser cookie with CSRF, or machine bearer):
//! - `GET /api/v2/agent-timer-grants`: every conversation with its grant
//!   state (never a grant value), for provisioning.
//! - `GET|PUT|DELETE /api/v2/conversations/{id}/agent-timer-grant`: read,
//!   issue/rotate (shown once) or revoke the conversation's grant.
//!
//! Grant holder (header `x-orkestr-agent-timer-grant`, machine requests only,
//! never with a cookie, bearer or Origin), only while the conversation has a
//! running Deep turn:
//! - `GET  .../agent-timers`: every timer of this conversation.
//! - `POST .../agent-timers`: create and enable one (201, or 200 for a replay).
//! - `POST .../agent-timers/{namespace}/control`: cancel, pause, resume or
//!   skip_next one timer of this conversation.
//!
//! The conversation is the grant's: a request never names one, and a timer
//! of any other conversation is not found. No route here starts a provider;
//! the trusted timer scheduler runs the timer like any other.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::conversation;
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_store_sqlite::ResourceError;

pub(crate) fn router() -> Router<AppState> {
    let base = "/api/v2/conversations/{id}";
    Router::new()
        .route("/api/v2/agent-timer-grants", get(directory))
        .route(
            &format!("{base}/agent-timer-grant"),
            get(grant_read).put(grant_issue).delete(grant_revoke),
        )
        .route(&format!("{base}/agent-timers"), get(list).post(create))
        .route(
            &format!("{base}/agent-timers/{{namespace}}/control"),
            post(control),
        )
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_agent_timer",
        "Invalid agent timer request",
    )
}
pub(crate) fn failure(error: ResourceError) -> Error {
    match error {
        ResourceError::Invalid => invalid(),
        ResourceError::Unauthorized => unauthorized(),
        ResourceError::NotFound => Error(StatusCode::NOT_FOUND, "not_found", "Not found"),
        ResourceError::Conflict(code) => {
            let (status, message) = match code {
                "agent_timer_not_found" => (
                    StatusCode::NOT_FOUND,
                    "This conversation has no timer with that ID",
                ),
                "agent_timer_no_running_turn" => (
                    StatusCode::CONFLICT,
                    "Only a running Deep turn of this conversation may use its timers",
                ),
                "agent_timer_rate_limited" => (
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many recent timer requests from this conversation",
                ),
                "agent_timer_limit_reached" => (
                    StatusCode::TOO_MANY_REQUESTS,
                    "This conversation has the most live agent timers allowed",
                ),
                "agent_timer_too_soon" => (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "A one-shot timer must be at least 2 minutes ahead",
                ),
                "agent_timer_too_far" => (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "A timer may be at most 400 days ahead",
                ),
                "agent_timer_too_frequent" => (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "A recurring timer may run at most every 30 minutes",
                ),
                "agent_timer_invalid_schedule" => {
                    (StatusCode::UNPROCESSABLE_ENTITY, "Invalid timer schedule")
                }
                "agent_timer_pause_invalid" => (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "A pause must end in the future and within 60 days",
                ),
                "agent_timer_skip_once" => (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "A one-shot timer cannot skip its run; cancel it instead",
                ),
                "agent_timer_not_running" => {
                    (StatusCode::CONFLICT, "The timer has no next run to skip")
                }
                "agent_timer_ended" => (
                    StatusCode::CONFLICT,
                    "The timer is cancelled, stopped or finished",
                ),
                "agent_timer_conflict" => (
                    StatusCode::CONFLICT,
                    "This request_key was already used for a different request",
                ),
                "agent_timer_conversation_unavailable" => (
                    StatusCode::CONFLICT,
                    "This conversation is restricted or archived",
                ),
                _ => (StatusCode::CONFLICT, "Precondition refused"),
            };
            Error(status, code, message)
        }
        ResourceError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Storage unavailable",
        ),
    }
}
fn body<T>(value: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    value.map(|Json(v)| v).map_err(|_| invalid())
}
fn namespace(value: &str) -> Result<Uuid, Error> {
    Uuid::parse_str(value)
        .ok()
        .filter(|id| !id.is_nil() && id.hyphenated().to_string() == value)
        .ok_or_else(invalid)
}
/// Exactly one grant header and no browser or owner credential beside it.
fn grant(headers: &HeaderMap) -> Result<String, Error> {
    let mut grants = headers.get_all(AGENT_TIMER_GRANT_HEADER).iter();
    let value = grants.next().ok_or_else(unauthorized)?;
    if grants.next().is_some()
        || [header::COOKIE, header::AUTHORIZATION, header::ORIGIN]
            .iter()
            .any(|h| headers.contains_key(h))
    {
        return Err(unauthorized());
    }
    Ok(value.to_str().map_err(|_| unauthorized())?.to_owned())
}

async fn directory(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .agent_timer_grant_directory(&credential, &owner)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn grant_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .agent_timer_grant(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn grant_issue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .issue_agent_timer_grant(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok((StatusCode::CREATED, Json(value)).into_response())
}
async fn grant_revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .revoke_agent_timer_grant(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let grant = grant(&headers)?;
    let value = state
        .store
        .agent_timers(&grant, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<AgentTimerCreate>, JsonRejection>,
) -> Result<Response, Error> {
    let grant = grant(&headers)?;
    let request = body(request)?;
    let receipt = state
        .store
        .create_agent_timer(&grant, &conversation(&id)?, &request)
        .await
        .map_err(failure)?;
    Ok((
        if receipt.changed {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(receipt),
    )
        .into_response())
}
async fn control(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, timer)): Path<(String, String)>,
    request: Result<Json<AgentTimerControl>, JsonRejection>,
) -> Result<Response, Error> {
    let grant = grant(&headers)?;
    let request = body(request)?;
    let receipt = state
        .store
        .control_agent_timer(&grant, &conversation(&id)?, namespace(&timer)?, &request)
        .await
        .map_err(failure)?;
    Ok(Json(receipt).into_response())
}

#[cfg(test)]
#[path = "agent_timers_http_tests.rs"]
mod tests;
