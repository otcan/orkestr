//! Conversation posts: assistant-side messages from outside a run.
//!
//! - `POST /api/v2/conversations/{id}/posts`: write one (201), or replay the
//!   same `request_key` and body (200). A different body is 409.
//! - `GET /api/v2/conversations/{id}/posts?pending=true&limit=N`: undelivered,
//!   oldest first (the WhatsApp delivery adapter).
//! - `GET /api/v2/conversations/{id}/posts?after_ms=T&limit=N`: created after
//!   `T`, oldest first; without `after_ms` the newest N, oldest first (the UI).
//! - `POST /api/v2/conversations/{id}/posts/{post}/delivered`: idempotent.
//!
//! Owner credential only (browser cookie with CSRF, or a machine bearer). A
//! post never admits input, wakes or steers a provider, or starts execution.
use super::*;
use crate::archived_history_http::owner_credential;
use axum::extract::{
    rejection::{JsonRejection, QueryRejection},
    Path, Query,
};
use orkestr_v2_store_sqlite::{PostListing, ResourceError};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/conversations/{id}/posts", get(list).post(create))
        .route(
            "/api/v2/conversations/{id}/posts/{post}/delivered",
            post(delivered),
        )
}

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Listing {
    pending: Option<bool>,
    after_ms: Option<i64>,
    limit: Option<u16>,
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_conversation_post",
        "Invalid conversation post request",
    )
}
fn failure(error: ResourceError) -> Error {
    match error {
        ResourceError::Invalid => invalid(),
        ResourceError::Unauthorized => unauthorized(),
        ResourceError::NotFound => Error(StatusCode::NOT_FOUND, "not_found", "Not found"),
        ResourceError::Conflict("conversation_post_conflict") => Error(
            StatusCode::CONFLICT,
            "conversation_post_conflict",
            "This request_key was already used for a different post",
        ),
        ResourceError::Conflict("conversation_archived") => Error(
            StatusCode::CONFLICT,
            "conversation_archived",
            "This conversation's chat is archived",
        ),
        ResourceError::Conflict(code) => Error(StatusCode::CONFLICT, code, "Precondition refused"),
        ResourceError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Storage unavailable",
        ),
    }
}
fn identity(id: &str) -> Result<Uuid, Error> {
    Uuid::parse_str(id)
        .ok()
        .filter(|v| !v.is_nil() && v.hyphenated().to_string() == id)
        .ok_or_else(invalid)
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ConversationPostRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = ConversationId(identity(&id)?);
    let Json(body) = body.map_err(|_| invalid())?;
    let receipt = state
        .store
        .create_conversation_post(&credential, &owner, &conversation, &body)
        .await
        .map_err(failure)?;
    let status = if receipt.created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(receipt.post)).into_response())
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<Listing>, QueryRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = ConversationId(identity(&id)?);
    let Query(query) = query.map_err(|_| invalid())?;
    let listing = match (query.pending, query.after_ms) {
        (Some(true), None) => PostListing::Pending,
        (Some(_), _) => return Err(invalid()),
        (None, Some(after)) if after >= 0 => PostListing::After(after),
        (None, Some(_)) => return Err(invalid()),
        (None, None) => PostListing::Latest,
    };
    let posts = state
        .store
        .conversation_posts(
            &credential,
            &owner,
            &conversation,
            listing,
            query.limit.unwrap_or(50),
        )
        .await
        .map_err(failure)?;
    let page = ConversationPosts {
        conversation_id: conversation,
        posts,
    };
    if !page.is_valid() {
        return Err(failure(ResourceError::Unavailable));
    }
    Ok(Json(page).into_response())
}

async fn delivered(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, post)): Path<(String, String)>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = ConversationId(identity(&id)?);
    let value = state
        .store
        .deliver_conversation_post(&credential, &owner, &conversation, identity(&post)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

#[cfg(test)]
#[path = "conversation_posts_http_tests.rs"]
mod tests;
