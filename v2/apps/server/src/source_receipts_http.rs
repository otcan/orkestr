//! A lookup, never an admission or completion command.
use crate::{AppState, Error};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use orkestr_v2_contracts::*;
use uuid::Uuid;

fn json<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    body.map(|Json(value)| value).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "Invalid request body",
        )
    })
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v2/conversations/{id}/source-receipts/lookup",
            post(lookup),
        )
        .route(
            "/api/v2/conversations/{id}/source-runs/lookup",
            post(context),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
}

async fn context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<SourceContextQuery>, JsonRejection>,
) -> Result<Json<SourceContextProof>, Error> {
    let (owner, credential) =
        crate::archived_history_http::owner_credential(&state, &headers).await?;
    let conversation = Uuid::parse_str(&id)
        .ok()
        .filter(|id| !id.is_nil())
        .map(ConversationId)
        .ok_or(Error(
            StatusCode::BAD_REQUEST,
            "invalid_conversation",
            "Invalid conversation",
        ))?;
    Ok(Json(
        state
            .store
            .source_context(&credential, &owner, &conversation, &json(body)?)
            .await?,
    ))
}
async fn lookup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<SourceReceiptQuery>, JsonRejection>,
) -> Result<Json<SourceReceiptProjection>, Error> {
    let (owner, credential) =
        crate::archived_history_http::owner_credential(&state, &headers).await?;
    let conversation = Uuid::parse_str(&id)
        .ok()
        .filter(|id| !id.is_nil())
        .map(ConversationId)
        .ok_or(Error(
            StatusCode::BAD_REQUEST,
            "invalid_conversation",
            "Invalid conversation",
        ))?;
    Ok(Json(
        state
            .store
            .source_receipt(&credential, &owner, &conversation, &json(body)?)
            .await?,
    ))
}
