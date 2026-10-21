//! Local-only metrics listener. It binds a separate IPv4 loopback port that
//! the public reverse proxy never forwards to, and serves only
//! `GET /metrics` (Prometheus text) and `GET /metrics.json?window=SECONDS`.
//! No owner data: route templates, counts and durations only.
use super::Observer;
use axum::{
    extract::{rejection::QueryRejection, Query},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use std::{net::SocketAddr, time::Duration};

/// Environment key naming the loopback `IP:PORT` of the metrics listener.
pub const METRICS_BIND_ENV: &str = "ORKESTR_V2_METRICS_BIND";

const DEFAULT_WINDOW: Duration = Duration::from_secs(300);

pub fn parse_bind(value: &str) -> Result<SocketAddr, &'static str> {
    let address: SocketAddr = value
        .trim()
        .parse()
        .map_err(|_| "metrics bind must be IP:PORT")?;
    if !address.ip().is_loopback() || address.port() == 0 {
        return Err("metrics bind must be a loopback address with a port");
    }
    Ok(address)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WindowQuery {
    window: Option<u64>,
}

fn window(query: Result<Query<WindowQuery>, QueryRejection>) -> Result<Duration, &'static str> {
    match query.map_err(|_| "invalid query")?.0.window {
        None => Ok(DEFAULT_WINDOW),
        Some(seconds) if (10..=3600).contains(&seconds) => Ok(Duration::from_secs(seconds)),
        Some(_) => Err("window must be 10..3600 seconds"),
    }
}

async fn prometheus(query: Result<Query<WindowQuery>, QueryRejection>) -> Response {
    match window(query) {
        Ok(window) => (
            [
                (
                    header::CONTENT_TYPE,
                    "text/plain; version=0.0.4; charset=utf-8",
                ),
                (header::CACHE_CONTROL, "no-store"),
            ],
            Observer::global().metrics.prometheus(window),
        )
            .into_response(),
        Err(reason) => (StatusCode::BAD_REQUEST, reason).into_response(),
    }
}

async fn summary(query: Result<Query<WindowQuery>, QueryRejection>) -> Response {
    match window(query) {
        Ok(window) => {
            let observer = Observer::global();
            (
                [(header::CACHE_CONTROL, "no-store")],
                axum::Json(observer.metrics.summary(window, observer.slow_threshold())),
            )
                .into_response()
        }
        Err(reason) => (StatusCode::BAD_REQUEST, reason).into_response(),
    }
}

pub fn router() -> Router {
    Router::new()
        .route("/metrics", get(prometheus))
        .route("/metrics.json", get(summary))
        .fallback(|| async { StatusCode::NOT_FOUND })
}

/// Binds the listener now (startup fails on a bad or busy address) and
/// serves it on a background task for the life of the process.
pub async fn spawn(address: SocketAddr) -> std::io::Result<SocketAddr> {
    let listener = tokio::net::TcpListener::bind(address).await?;
    let bound = listener.local_addr()?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, router()).await;
    });
    Ok(bound)
}
