use super::{
    security,
    wire::{self, Decision, Propose, Records, Selection},
};
use crate::{AppState, Error};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use orkestr_v2_contracts::MemoryQuery;
pub(super) fn router(state: AppState) -> Router<AppState> {
    Router::new()
        .route("/api/v2/memory/settings", get(settings).put(select))
        .route("/api/v2/memory/proposals", post(propose))
        .route("/api/v2/memory/decisions", post(decide))
        .route("/api/v2/memory/query", post(query))
        .route("/api/v2/memory/export", get(export))
        .layer(DefaultBodyLimit::max(wire::REQUEST_MAX))
        .layer(middleware::from_fn_with_state(state, security::gate))
}
async fn settings(State(s): State<AppState>, h: HeaderMap) -> Result<Response, Error> {
    let result = s
        .store
        .memory_settings_authenticated(&security::credential(&h)?)
        .await
        .map_err(wire::error)?;
    wire::response(&result, wire::REQUEST_MAX)
}
async fn select(
    State(s): State<AppState>,
    h: HeaderMap,
    b: Result<Json<Selection>, JsonRejection>,
) -> Result<Response, Error> {
    s.store
        .set_memory_enabled_authenticated(&security::credential(&h)?, wire::json(b)?.enabled)
        .await
        .map_err(wire::error)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
async fn propose(
    State(s): State<AppState>,
    h: HeaderMap,
    b: Result<Json<Propose>, JsonRejection>,
) -> Result<Response, Error> {
    let b = wire::json(b)?;
    let result = s
        .store
        .propose_memory_authenticated(&security::credential(&h)?, &b.request_key, b.operation)
        .await
        .map_err(wire::error)?;
    wire::response(&result, wire::REQUEST_MAX)
}
async fn decide(
    State(s): State<AppState>,
    h: HeaderMap,
    b: Result<Json<Decision>, JsonRejection>,
) -> Result<Response, Error> {
    let b = wire::json(b)?;
    let result = s
        .store
        .save_memory_authenticated(&security::credential(&h)?, &b.proposal, &b.decision)
        .await
        .map_err(wire::error)?;
    wire::response(&result, wire::REQUEST_MAX)
}
async fn query(
    State(s): State<AppState>,
    h: HeaderMap,
    b: Result<Json<MemoryQuery>, JsonRejection>,
) -> Result<Response, Error> {
    let result = s
        .store
        .retrieve_memories_authenticated(&security::credential(&h)?, &wire::json(b)?)
        .await
        .map_err(wire::error)?;
    wire::response(&Records { records: result }, wire::QUERY_MAX)
}
async fn export(State(s): State<AppState>, h: HeaderMap) -> Result<Response, Error> {
    let result = s
        .store
        .export_memories_authenticated(&security::credential(&h)?)
        .await
        .map_err(wire::error)?;
    let mut response = wire::response(&Records { records: result }, wire::EXPORT_MAX)?;
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        axum::http::HeaderValue::from_static("attachment; filename=\"memory-export.json\""),
    );
    Ok(response)
}
