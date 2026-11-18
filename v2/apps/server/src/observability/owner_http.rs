//! The owner's request metrics, `GET /api/v2/request-metrics?window=SECONDS`
//! (10..=3600, default 300): the same JSON summary the local-only metrics
//! listener serves (per route p50/p95/p99, errors, response bytes and rows,
//! and the conversations with the most request time) for a password-signed-in
//! owner browser session, so a slow chat can be read from the browser.
use super::Observer;
use crate::{browser, AppState, Error};
use axum::{
    extract::{rejection::QueryRejection, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use std::time::Duration;

pub(crate) const PATH: &str = "/api/v2/request-metrics";
const DEFAULT_WINDOW: Duration = Duration::from_secs(300);

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WindowQuery {
    window: Option<u64>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(PATH, get(read))
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_window",
        "The window must be 10 to 3600 seconds",
    )
}

async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<WindowQuery>, QueryRejection>,
) -> Result<Response, Error> {
    browser::password_session(&state, &headers).await?;
    let window = match query.map_err(|_| invalid())?.0.window {
        None => DEFAULT_WINDOW,
        Some(seconds) if (10..=3600).contains(&seconds) => Duration::from_secs(seconds),
        Some(_) => return Err(invalid()),
    };
    let observer = Observer::global();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(observer.metrics.summary(window, observer.slow_threshold())),
    )
        .into_response())
}
