//! Per-request context carried in a task-local: the request id, upstream
//! call timings and named spans. Work spawned onto other tasks re-enters the
//! same context with [`scoped`].
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// One upstream call made while serving a request.
#[derive(Debug, Clone)]
pub(crate) struct UpstreamCall {
    /// Upstream system, e.g. `v1`.
    pub target: &'static str,
    /// Path template without query or identifiers, e.g. `/api/threads/{id}/messages`.
    pub route: String,
    /// HTTP status, or 0 when there was no answer (timeout, refused).
    pub status: u16,
    pub elapsed: Duration,
}

pub(crate) struct RequestContext {
    pub id: String,
    upstream: Mutex<Vec<UpstreamCall>>,
    spans: Mutex<Vec<(&'static str, Duration)>>,
}

/// Bounded so a pathological handler cannot grow a request's record.
const MAX_ENTRIES: usize = 64;

impl RequestContext {
    pub fn new(id: String) -> Self {
        Self {
            id,
            upstream: Mutex::new(Vec::new()),
            spans: Mutex::new(Vec::new()),
        }
    }
    pub fn upstream_calls(&self) -> Vec<UpstreamCall> {
        self.upstream.lock().map(|c| c.clone()).unwrap_or_default()
    }
    /// Spans with the same name are summed (e.g. several store reads).
    pub fn spans(&self) -> Vec<(&'static str, Duration)> {
        self.spans.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

tokio::task_local! {
    static CONTEXT: Arc<RequestContext>;
}

pub(crate) fn current() -> Option<Arc<RequestContext>> {
    CONTEXT.try_with(Arc::clone).ok()
}

pub(crate) fn request_id() -> Option<String> {
    CONTEXT.try_with(|c| c.id.clone()).ok()
}

/// Runs `future` inside `context` (no-op without one), e.g. for spawned work.
pub(crate) async fn scoped<F: Future>(
    context: Option<Arc<RequestContext>>,
    future: F,
) -> F::Output {
    match context {
        Some(context) => CONTEXT.scope(context, future).await,
        None => future.await,
    }
}

/// Records an upstream call on the current request, if any. Calls outside a
/// request (background refreshes) are recorded in the global metrics only.
pub(crate) fn upstream(target: &'static str, route: String, status: u16, started: Instant) {
    let call = UpstreamCall {
        target,
        route,
        status,
        elapsed: started.elapsed(),
    };
    match current() {
        Some(context) => {
            if let Ok(mut calls) = context.upstream.lock() {
                if calls.len() < MAX_ENTRIES {
                    calls.push(call);
                }
            }
        }
        None => super::Observer::global().metrics.record_upstream(
            call.target,
            &call.route,
            call.status,
            call.elapsed,
        ),
    }
}

/// Adds the time since `started` to the named span of the current request.
pub(crate) fn span(name: &'static str, started: Instant) {
    let elapsed = started.elapsed();
    if let Some(context) = current() {
        if let Ok(mut spans) = context.spans.lock() {
            if let Some(index) = spans.iter().position(|(n, _)| *n == name) {
                spans[index].1 += elapsed;
            } else if spans.len() < MAX_ENTRIES {
                spans.push((name, elapsed));
            }
        }
    }
}
