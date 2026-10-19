use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::{AutomaticReplyPermissionRequest, ConversationId};
use serde::Deserialize;
use uuid::Uuid;

pub(crate) fn router() -> Router<crate::AppState> {
    Router::new()
        .route(
            "/conversations/{conversation}/automatic-reply-permissions",
            get(status).post(set_permission),
        )
        .layer(DefaultBodyLimit::max(2048))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    after_id: Option<Uuid>,
    #[serde(default = "page_size")]
    limit: u16,
}
fn page_size() -> u16 {
    16
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoQuery {}
fn invalid() -> crate::Error {
    crate::Error(
        StatusCode::BAD_REQUEST,
        "invalid_input",
        "Invalid permission request",
    )
}
fn failure(error: RuntimeStoreError) -> crate::Error {
    use RuntimeStoreError::*;
    match error {
        Unauthorized => crate::unauthorized(),
        InvalidInput => invalid(),
        NotFound | Fenced => crate::Error(
            StatusCode::NOT_FOUND,
            "not_found",
            "Permission route not found",
        ),
        Conflict | Busy | StaleLease | Expired => crate::Error(
            StatusCode::CONFLICT,
            "permission_conflict",
            "Permission changed or request key conflicts",
        ),
        Unavailable => crate::Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "permission_unavailable",
            "Permission storage unavailable",
        ),
    }
}
async fn credential(state: &crate::AppState, headers: &HeaderMap) -> Result<String, crate::Error> {
    crate::browser::owner(state, headers).await?;
    // Preserve the exact namespaced cookie credential for transaction-time auth.
    // Browser owner preflight is not authority for the subsequent Store operation.
    crate::browser::credential(headers)
}
async fn status(
    State(state): State<crate::AppState>,
    headers: HeaderMap,
    Path(conversation): Path<ConversationId>,
    Query(page): Query<Page>,
) -> Result<Response, crate::Error> {
    let credential = credential(&state, &headers).await?;
    let page = state
        .store
        .automatic_reply_permissions_authenticated(
            &credential,
            &conversation,
            page.after_id,
            page.limit,
        )
        .await
        .map_err(failure)?;
    if !page.is_valid() || page.conversation_id != conversation {
        return Err(failure(RuntimeStoreError::Unavailable));
    }
    Ok(Json(page).into_response())
}
async fn set_permission(
    State(state): State<crate::AppState>,
    headers: HeaderMap,
    Path(conversation): Path<ConversationId>,
    Query(_): Query<NoQuery>,
    input: Result<Json<AutomaticReplyPermissionRequest>, JsonRejection>,
) -> Result<Response, crate::Error> {
    let credential = credential(&state, &headers).await?;
    crate::browser::guard(
        &state,
        &Method::POST,
        "automatic-reply-permissions",
        &headers,
    )
    .await?;
    let Json(input) = input.map_err(|_| invalid())?;
    let receipt = state
        .store
        .set_automatic_reply_permission_authenticated(&credential, &conversation, &input)
        .await
        .map_err(failure)?;
    // Historical receipts are immutable decisions, not a fresh policy sample.
    Ok(Json(receipt).into_response())
}
