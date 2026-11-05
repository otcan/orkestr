//! Authenticated factual intake lookup, never an approval or command.
use crate::{AppState, Error};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use orkestr_v2_contracts::*;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v2/conversations/{id}/root-intake/lookup",
            post(lookup),
        )
        .layer(DefaultBodyLimit::max(4096))
}

async fn lookup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    query: Result<Json<RootIntakeQuery>, JsonRejection>,
) -> Result<Json<RootIntakeProof>, Error> {
    let (owner, credential) =
        crate::archived_history_http::owner_credential(&state, &headers).await?;
    let Json(query) = query.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "Invalid request body",
        )
    })?;
    Ok(Json(
        state
            .store
            .root_intake(&credential, &owner, &ConversationId(id), &query)
            .await?,
    ))
}
