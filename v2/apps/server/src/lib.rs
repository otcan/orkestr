//! Local API with separate machine Bearer and browser cookie authentication.
mod static_ui;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
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
mod execution;
mod resource_health;
mod routes;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    execution_store: Option<Store>,
    bootstrap_token: Arc<String>,
    origin: Arc<String>,
    authority: Arc<String>,
    auth_window: Arc<Mutex<(Instant, u32)>>,
    resources: resource_health::ResourceSampler,
}
impl AppState {
    /// Trusted bootstrap only; browser input never selects supervisor authority.
    pub fn with_execution_store(mut self, store: Store) -> Self {
        self.execution_store = Some(store);
        self
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
            store,
            execution_store: None,
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
        .route("/api/v2/health",get(|| async { Json(serde_json::json!({"status":"ok","product":"orkestr-v2","contract_version":0,"fixture_mode":false})) }))
        .route("/api/v2/setup",post(auth::setup))
        .route("/api/v2/session",post(auth::session))
        .route("/api/v2/machine/session",post(auth::session))
        .route("/api/v2/browser/session",post(browser::login).get(browser::session).delete(browser::logout))
        .route("/api/v2/projects",get(routes::projects).post(routes::create_project))
        .route("/api/v2/resources",get(resource_health::resources))
        .route("/api/v2/conversations/{id}",get(routes::snapshot))
        .route("/api/v2/conversations/{id}/execution",get(execution::status))
        .route("/api/v2/conversations/{id}/stop",post(execution::stop))
        .route("/api/v2/conversations/{id}/messages",post(routes::message))
        .route("/api/v2/conversations/{id}/events",get(routes::events))
        .fallback(|| async { Error(StatusCode::NOT_FOUND,"not_found","Endpoint not found") })
        .layer(DefaultBodyLimit::max(40 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(),guard))
        .with_state(state)
}
