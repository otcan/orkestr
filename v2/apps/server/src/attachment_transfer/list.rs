//! Bounded reload discovery; a cursor never supplies owner authority.
use super::{authority, routes::failure};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use orkestr_v2_contracts::ConversationId;
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PageQuery {
    after_id: Option<Uuid>,
    #[serde(default = "default_limit")]
    limit: u16,
}
fn default_limit() -> u16 {
    16
}

pub(super) async fn get(
    State(state): State<crate::AppState>,
    Path(conversation): Path<ConversationId>,
    Query(page): Query<PageQuery>,
    headers: HeaderMap,
) -> Response {
    let (owner, credential) = match authority::credential(&state, &headers).await {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    match state
        .store
        .attachment_manifests_authenticated(
            &credential,
            &owner,
            &conversation,
            page.after_id,
            page.limit,
        )
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(error),
    }
}
