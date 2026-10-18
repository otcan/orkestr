//! Minimal authenticated local API. Bearer sessions avoid ambient cookie authority.
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
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;
mod auth;
mod routes;
mod static_ui;
pub use static_ui::with_static_ui;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    bootstrap_token: Arc<String>,
    origin: Arc<String>,
    auth_window: Arc<Mutex<(Instant, u32)>>,
}
impl AppState {
    pub fn new(
        store: Store,
        bootstrap_token: String,
        origin: String,
    ) -> Result<Self, &'static str> {
        if bootstrap_token.len() < 32 {
            return Err("bootstrap token needs at least 32 characters");
        }
        Ok(Self {
            store,
            bootstrap_token: Arc::new(bootstrap_token),
            origin: Arc::new(origin),
            auth_window: Arc::new(Mutex::new((Instant::now(), 0))),
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
pub(crate) async fn owner(state: &AppState, headers: &HeaderMap) -> Result<OwnerId, Error> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.len() <= 256)
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
        .route("/api/v2/projects",get(routes::projects).post(routes::create_project))
        .route("/api/v2/conversations/{id}",get(routes::snapshot))
        .route("/api/v2/conversations/{id}/messages",post(routes::message))
        .route("/api/v2/conversations/{id}/events",get(routes::events))
        .fallback(|| async { Error(StatusCode::NOT_FOUND,"not_found","Endpoint not found") })
        .layer(DefaultBodyLimit::max(40 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(),guard))
        .with_state(state)
}
