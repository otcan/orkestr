//! Local API with separate machine Bearer and browser cookie authentication.
mod static_ui;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use orkestr_v2_application::StoreError;
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::Store;
pub use static_ui::with_static_ui;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;
mod auth;
mod browser;
pub mod build_identity;
pub mod claude_execution;
pub mod control_dispatch;
pub mod control_registry;
mod execution;
mod execution_accept;
mod execution_registry;
pub mod fast_execution;
mod held_inputs;
pub mod offline_python;
pub mod owned_children;
pub mod owned_execution;
mod provider_payload;
mod resource_health;
mod routes;
mod steering_http;
mod steering_registry;
pub mod stop_execution;
pub mod timer_bootstrap;
pub mod timer_http;
mod timer_lifecycle;
mod worker_discovery;
pub mod worker_execution;
pub mod worker_tasks;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    executions: execution_registry::ExecutionRegistry,
    fast_executions: execution_registry::ExecutionRegistry,
    bootstrap_token: Arc<String>,
    origin: Arc<String>,
    authority: Arc<String>,
    auth_window: Arc<Mutex<(Instant, u32)>>,
    resources: resource_health::ResourceSampler,
    timers: timer_http::DurableOwnerController,
}
impl AppState {
    /// The ordinary server owns the bounded controller task and its shutdown.
    pub fn start_timers(&self, supervisor: Store) -> timer_lifecycle::TimerTask {
        timer_lifecycle::TimerTask::start(
            timer_http::durable::DurableTimerController::new(supervisor),
            self.timers.ready.clone(),
        )
    }
    pub fn new(
        store: Store,
        bootstrap_token: String,
        origin: String,
    ) -> Result<Self, &'static str> {
        if bootstrap_token.len() < 32 {
            return Err("bootstrap token needs at least 32 characters");
        }
        let uri: axum::http::Uri = origin.parse().map_err(|_| "invalid origin")?;
        if !matches!(uri.scheme_str(), Some("http" | "https"))
            || uri.path_and_query().is_some_and(|p| p.as_str() != "/")
            || origin.ends_with('/')
        {
            return Err("origin must be an http(s) origin without path");
        }
        let authority = uri
            .authority()
            .ok_or("origin needs authority")?
            .as_str()
            .to_owned();
        if authority.contains('@') {
            return Err("origin cannot contain user information");
        }
        Ok(Self {
            timers: timer_http::DurableOwnerController::new(store.clone()),
            store,
            executions: execution_registry::ExecutionRegistry::default(),
            fast_executions: execution_registry::ExecutionRegistry::default(),
            bootstrap_token: Arc::new(bootstrap_token),
            origin: Arc::new(origin),
            authority: Arc::new(authority),
            auth_window: Arc::new(Mutex::new((Instant::now(), 0))),
            resources: resource_health::ResourceSampler::new(),
        })
    }
}
pub struct Error(StatusCode, &'static str, &'static str);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(ApiError {
                code: self.1.into(),
                message: self.2.into(),
                request_id: Uuid::new_v4().to_string(),
                retryable: self.0 == StatusCode::SERVICE_UNAVAILABLE,
            }),
        )
            .into_response()
    }
}
impl From<StoreError> for Error {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Invalid => Self(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "Invalid input or cursor",
            ),
            StoreError::Conflict => Self(
                StatusCode::CONFLICT,
                "idempotency_conflict",
                "Request key already used with different content",
            ),
            StoreError::NotFound => {
                Self(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
            }
            StoreError::AlreadySetup => Self(
                StatusCode::CONFLICT,
                "already_setup",
                "Administrator already exists",
            ),
            StoreError::Unavailable => Self(
                StatusCode::SERVICE_UNAVAILABLE,
                "store_unavailable",
                "Storage unavailable",
            ),
        }
    }
}
pub(crate) fn unauthorized() -> Error {
    Error(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "Authentication required",
    )
}
/// Machine credentials and Bearer authority cannot be used by Origin-bearing clients.
pub(crate) fn machine_request(headers: &HeaderMap) -> Result<(), Error> {
    if headers.contains_key(header::ORIGIN) {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "machine_origin_rejected",
            "Machine authentication requires no Origin header",
        ));
    }
    Ok(())
}
pub(crate) async fn owner(state: &AppState, headers: &HeaderMap) -> Result<OwnerId, Error> {
    if headers.contains_key(header::COOKIE) {
        if headers.contains_key(header::AUTHORIZATION) {
            return Err(unauthorized());
        }
        return browser::owner(state, headers).await;
    }
    machine_request(headers)?;
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(unauthorized)?;
    state
        .store
        .authenticate(token)
        .await?
        .ok_or_else(unauthorized)
}
async fn guard(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        if origin.to_str().ok() != Some(state.origin.as_str()) {
            return Error(StatusCode::FORBIDDEN, "origin_rejected", "Origin rejected")
                .into_response();
        }
    }
    if let Err(error) = browser::guard(
        &state,
        request.method(),
        request.uri().path(),
        request.headers(),
    )
    .await
    {
        return error.into_response();
    }
    let mut response = match tokio::time::timeout(Duration::from_secs(10), next.run(request)).await
    {
        Ok(response) => response,
        Err(_) => {
            return Error(
                StatusCode::REQUEST_TIMEOUT,
                "request_timeout",
                "Request deadline exceeded",
            )
            .into_response()
        }
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v2/health",get(|| async { Json(serde_json::json!({"status":"ok","product":"orkestr-v2","contract_version":0,"fixture_mode":false,"build":build_identity::identity()})) }))
        .route("/api/v2/setup",post(auth::setup))
        .route("/api/v2/session",post(auth::session))
        .route("/api/v2/machine/session",post(auth::session))
        .route("/api/v2/browser/session",post(browser::login).get(browser::session).delete(browser::logout))
        .route("/api/v2/projects",get(routes::projects).post(routes::create_project))
        .route("/api/v2/resources",get(resource_health::resources))
        .route("/api/v2/conversations/{id}",get(routes::snapshot))
        .route("/api/v2/conversations/{id}/execution",get(execution::status))
        .route("/api/v2/conversations/{id}/fast/execution",get(execution::fast_status))
        .route("/api/v2/conversations/{id}/workers",get(worker_discovery::list))
        .route("/api/v2/conversations/{id}/worker-tasks",get(worker_tasks::list).post(worker_tasks::create))
        .route("/api/v2/conversations/{id}/worker-tasks/{task}/hold",post(worker_tasks::hold))
        .route("/api/v2/conversations/{id}/worker-tasks/{task}/payload",delete(worker_tasks::remove))
        .route("/api/v2/conversations/{id}/stop",post(execution::stop))
        .route("/api/v2/conversations/{id}/fast/stop",post(execution::fast_stop))
        .route("/api/v2/conversations/{id}/steer",post(steering_http::submit))
        .route("/api/v2/conversations/{id}/steering/{key}",get(steering_http::status))
        .route("/api/v2/conversations/{id}/accept",post(execution_accept::accept))
        .route("/api/v2/conversations/{id}/payloads/{payload}",get(provider_payload::read).delete(provider_payload::remove))
        .route("/api/v2/conversations/{id}/held-inputs",get(held_inputs::read))
        .route("/api/v2/conversations/{id}/messages",post(routes::message))
        .route("/api/v2/conversations/{id}/events",get(routes::events))
        .merge(timer_http::routes(state.timers.clone()))
        .fallback(|| async { Error(StatusCode::NOT_FOUND,"not_found","Endpoint not found") })
        .layer(DefaultBodyLimit::max(40 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(),guard))
        .with_state(state)
}
