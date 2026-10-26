//! Scoped agent requests between conversations of one owner ("ask thread X").
//!
//! Owner (browser cookie with CSRF, or machine bearer):
//! - `GET|PUT|DELETE /api/v2/conversations/{id}/thread-ask-grant`: read,
//!   issue/rotate (shown once) or revoke the conversation's grant.
//! - `GET /api/v2/conversations/{id}/thread-asks?limit=N`: requests sent from
//!   or received by this conversation, newest first (no answers).
//! - `POST .../thread-asks/{ask}/cancel`: fail an unsettled request sent from
//!   or to this conversation (`cancelled_by_owner`).
//!
//! Grant holder (header `x-orkestr-thread-ask-grant`, machine requests only,
//! never with a cookie, bearer or Origin):
//! - `GET  .../thread-asks/targets`: conversations it may ask.
//! - `POST .../thread-asks`: send one request (202, or 200 for a replay).
//! - `GET  .../thread-asks/{ask}`: read-only status.
//! - `POST .../thread-asks/{ask}/collect`: return a settled outcome to the
//!   running asking turn; that same run may collect again while it runs.
//!
//! No route here starts a provider: the trusted scheduler queues the target's
//! ordinary Deep turn and returns the outcome. There is no V1 CLI or browser
//! pairing anywhere in this path.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::conversation;
use axum::extract::{
    rejection::{JsonRejection, QueryRejection},
    Path, Query,
};
use orkestr_v2_store_sqlite::ResourceError;

pub(crate) fn router() -> Router<AppState> {
    let base = "/api/v2/conversations/{id}";
    Router::new()
        .route(
            &format!("{base}/thread-ask-grant"),
            get(grant_read).put(grant_issue).delete(grant_revoke),
        )
        .route(&format!("{base}/thread-asks"), get(list).post(create))
        .route(&format!("{base}/thread-asks/targets"), get(targets))
        .route(&format!("{base}/thread-asks/{{ask}}"), get(status))
        .route(
            &format!("{base}/thread-asks/{{ask}}/collect"),
            post(collect),
        )
        .route(&format!("{base}/thread-asks/{{ask}}/cancel"), post(cancel))
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_thread_ask",
        "Invalid thread ask request",
    )
}
pub(crate) fn failure(error: ResourceError) -> Error {
    match error {
        ResourceError::Invalid => invalid(),
        ResourceError::Unauthorized => unauthorized(),
        ResourceError::NotFound => Error(StatusCode::NOT_FOUND, "not_found", "Not found"),
        ResourceError::Conflict(code) => {
            let (status, message) = match code {
                "thread_ask_self" => (StatusCode::BAD_REQUEST, "A conversation cannot ask itself"),
                "thread_ask_target_not_found" => (
                    StatusCode::NOT_FOUND,
                    "No conversation of this owner has that ID",
                ),
                "thread_ask_target_not_allowed" => (
                    StatusCode::FORBIDDEN,
                    "This grant may not ask that conversation",
                ),
                "thread_ask_rate_limited" => (
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many open or recent requests from this conversation",
                ),
                "thread_ask_no_running_turn" => (
                    StatusCode::CONFLICT,
                    "Only a running turn of this conversation may ask or collect",
                ),
                "thread_ask_chain_too_deep" => (
                    StatusCode::CONFLICT,
                    "A turn answering a forwarded request cannot forward it again",
                ),
                "thread_ask_conflict" => (
                    StatusCode::CONFLICT,
                    "This request_key was already used for a different request",
                ),
                "thread_ask_cycle" => (
                    StatusCode::CONFLICT,
                    "That conversation is waiting on a request from this one",
                ),
                "thread_ask_no_dispatcher" => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "No window dispatcher runs, so the target turn could not start",
                ),
                "thread_ask_target_unavailable" | "thread_ask_conversation_unavailable" => (
                    StatusCode::CONFLICT,
                    "That conversation is restricted or archived",
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
fn ask_id(value: &str) -> Result<Uuid, Error> {
    Uuid::parse_str(value)
        .ok()
        .filter(|id| !id.is_nil() && id.hyphenated().to_string() == value)
        .ok_or_else(invalid)
}
/// Exactly one grant header and no browser or owner credential beside it.
fn grant(headers: &HeaderMap) -> Result<String, Error> {
    let mut grants = headers.get_all(THREAD_ASK_GRANT_HEADER).iter();
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

async fn grant_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .thread_ask_grant(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn grant_issue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<ThreadAskGrantRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .issue_thread_ask_grant(&credential, &owner, &conversation(&id)?, &body(request)?)
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
        .revoke_thread_ask_grant(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Listing {
    limit: Option<u16>,
}
async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<Listing>, QueryRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Query(listing) = query.map_err(|_| invalid())?;
    let value = state
        .store
        .thread_asks_for_owner(
            &credential,
            &owner,
            &conversation(&id)?,
            listing.limit.unwrap_or(20),
        )
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn targets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let grant = grant(&headers)?;
    let value = state
        .store
        .thread_ask_targets(&grant, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(serde_json::json!({ "targets": value })).into_response())
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<ThreadAskRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let grant = grant(&headers)?;
    let request = body(request)?;
    let receipt = state
        .store
        .create_thread_ask(
            &grant,
            &conversation(&id)?,
            &request,
            state.window_controller.is_some(),
        )
        .await
        .map_err(failure)?;
    Ok((
        if receipt.created {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        },
        Json(receipt),
    )
        .into_response())
}
async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, ask)): Path<(String, String)>,
) -> Result<Response, Error> {
    let grant = grant(&headers)?;
    let value = state
        .store
        .thread_ask_status(&grant, &conversation(&id)?, ask_id(&ask)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn collect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, ask)): Path<(String, String)>,
) -> Result<Response, Error> {
    let grant = grant(&headers)?;
    let value = state
        .store
        .collect_thread_ask(&grant, &conversation(&id)?, ask_id(&ask)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, ask)): Path<(String, String)>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .cancel_thread_ask(&credential, &owner, &conversation(&id)?, ask_id(&ask)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

#[cfg(test)]
#[path = "thread_asks_http_tests.rs"]
mod tests;
