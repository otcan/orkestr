//! Request observability: a request id on every request (returned in
//! `x-request-id`, sent upstream to V1 and written to every log line), one
//! structured JSON log line per request with the route template, status,
//! duration and upstream timings, a slow-request warning above a threshold,
//! and per-route latency and error metrics for the local-only metrics
//! listener. Logs never contain bodies, query strings, cookies, tokens or
//! identifiers from the path: only the matched route template.
mod context;
mod log;
pub mod metrics;
pub mod metrics_http;
#[cfg(test)]
pub(crate) mod tests;

use axum::{
    extract::{MatchedPath, Request},
    http::{header, HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
    Router,
};
pub(crate) use context::{request_id, scoped, span, upstream, RequestContext};
use std::{
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

pub(crate) static REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

/// Environment key: requests at or above this many milliseconds are logged
/// as `slow_request` warnings (default 500).
pub const SLOW_MS_ENV: &str = "ORKESTR_V2_SLOW_MS";
/// Environment key: `all` logs every request, `quiet` all but successful fast
/// reads (the polling that dominates the log), `slow` (default) only slow and
/// failed ones, `off` none. Metrics are recorded in every mode. The service
/// package selects `quiet`; the default stays quiet for embedders and tests
/// that pipe stderr without reading it (a full pipe would block every other
/// stderr writer in the process).
pub const ACCESS_LOG_ENV: &str = "ORKESTR_V2_ACCESS_LOG";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessLog {
    All,
    Quiet,
    Slow,
    Off,
}

impl AccessLog {
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("off") => AccessLog::Off,
            Some("all") => AccessLog::All,
            Some("quiet") => AccessLog::Quiet,
            _ => AccessLog::Slow,
        }
    }
    /// Whether one finished request gets a log line. `Quiet` drops only fast
    /// GET/HEAD responses with a 2xx/3xx status: writes, client and server
    /// errors and slow requests are always kept.
    pub fn shows(self, method: &str, status: u16, slow: bool) -> bool {
        match self {
            AccessLog::All => true,
            AccessLog::Quiet => {
                slow || !(200..400).contains(&status) || !matches!(method, "GET" | "HEAD")
            }
            AccessLog::Slow => slow || status >= 500,
            AccessLog::Off => false,
        }
    }
}

pub struct Observer {
    pub metrics: metrics::Metrics,
    slow: Duration,
    access: AccessLog,
}

impl Observer {
    pub fn new(slow: Duration, access: AccessLog) -> Self {
        Self {
            metrics: metrics::Metrics::default(),
            slow,
            access,
        }
    }
    fn from_env() -> Self {
        let slow = std::env::var(SLOW_MS_ENV)
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|ms| (1..=600_000).contains(ms))
            .unwrap_or(500);
        let access = AccessLog::parse(std::env::var(ACCESS_LOG_ENV).ok().as_deref());
        Self::new(Duration::from_millis(slow), access)
    }
    /// The process-wide observer the HTTP layer and upstream clients report to.
    pub fn global() -> &'static Observer {
        static GLOBAL: LazyLock<Observer> = LazyLock::new(Observer::from_env);
        &GLOBAL
    }
    pub fn slow_threshold(&self) -> Duration {
        self.slow
    }
}

/// Where the inner route layer writes the matched route template, so the
/// outer layer (which runs before routing) can label the request.
#[derive(Clone, Default)]
struct RouteSlot(Arc<Mutex<Option<String>>>);

/// Inner layer (`Router::route_layer`): records the matched route template.
pub(crate) async fn record_route(request: Request, next: Next) -> Response {
    if let (Some(path), Some(slot)) = (
        request.extensions().get::<MatchedPath>(),
        request.extensions().get::<RouteSlot>(),
    ) {
        if let Ok(mut route) = slot.0.lock() {
            *route = Some(path.as_str().to_owned());
        }
    }
    next.run(request).await
}

/// A client-supplied id is kept only when it is short and plain; anything
/// else gets a fresh one. Ids are echoed in headers and logs, so never raw.
pub(crate) fn accepted_id(value: Option<&HeaderValue>) -> Option<String> {
    let value = value?.to_str().ok()?;
    (8..=64).contains(&value.len()).then_some(())?;
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        .then(|| value.to_owned())
}

pub(crate) fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Requests that are not API routes (static UI assets) share one label, so
/// arbitrary paths never create metric series.
fn label(route: Option<String>, path: &str) -> String {
    match route {
        Some(route) => route,
        None if path == "/api" || path.starts_with("/api/") => "unmatched".into(),
        None => "static".into(),
    }
}

/// Outer layer: id, timing, logging and metrics for every request.
pub(crate) async fn observe(mut request: Request, next: Next) -> Response {
    let observer = Observer::global();
    let started = Instant::now();
    let id = accepted_id(request.headers().get(&REQUEST_ID)).unwrap_or_else(new_id);
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let slot = RouteSlot::default();
    request.extensions_mut().insert(slot.clone());
    let context = Arc::new(RequestContext::new(id.clone()));
    let mut response = scoped(Some(context.clone()), next.run(request)).await;
    let elapsed = started.elapsed();
    let route = label(slot.0.lock().ok().and_then(|r| r.clone()), &path);
    let status = response.status().as_u16();
    let calls = context.upstream_calls();
    let spans = context.spans();
    let streaming = response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"text/event-stream"));
    // A streaming response's handler time is its setup, not the stream.
    observer
        .metrics
        .record(method.as_str(), &route, status, elapsed, streaming);
    for call in &calls {
        observer
            .metrics
            .record_upstream(call.target, &call.route, call.status, call.elapsed);
    }
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&id) {
        headers.insert(REQUEST_ID.clone(), value);
    }
    if let Ok(value) = HeaderValue::from_str(&log::server_timing(elapsed, &calls, &spans)) {
        headers.insert(HeaderName::from_static("server-timing"), value);
    }
    let slow = !streaming && elapsed >= observer.slow;
    if observer.access.shows(method.as_str(), status, slow) {
        log::request(&log::RequestLine {
            id: &id,
            method: method.as_str(),
            route: &route,
            status,
            elapsed,
            slow,
            streaming,
            upstream: &calls,
            spans: &spans,
        });
    }
    response
}

/// Wraps the whole application (API and static UI) in the observing layer.
/// The route layer must already be installed on the API router.
pub fn layer<S: Clone + Send + Sync + 'static>(router: Router<S>) -> Router<S> {
    router.layer(axum::middleware::from_fn(observe))
}
