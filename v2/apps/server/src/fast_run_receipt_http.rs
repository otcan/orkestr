//! Factual Fast lookup for the exact canary input. No provider invocation.
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
        .route("/api/v2/conversations/{id}/fast-runs/lookup", post(lookup))
        .layer(DefaultBodyLimit::max(4096))
}

async fn lookup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    body: Result<Json<FastRunReceiptQuery>, JsonRejection>,
) -> Result<Json<FastRunReceipt>, Error> {
    let (owner, credential) =
        crate::archived_history_http::owner_credential(&state, &headers).await?;
    let Json(query) = body.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "Invalid request body",
        )
    })?;
    Ok(Json(
        state
            .store
            .fast_run_receipt(&credential, &owner, &ConversationId(id), &query)
            .await?,
    ))
}
