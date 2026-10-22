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
mod accepted_results_http;
mod archived_history_http;
pub mod attachment_keys_http;
mod attachment_transfer;
mod auth;
mod automatic_reply_control;
mod beta_config;
mod beta_discovery_http;
mod browser;
pub mod build_identity;
pub mod claude_execution;
pub mod control_dispatch;
pub mod control_registry;
mod conversation_posts_http;
mod conversation_resources_http;
mod conversation_status_http;
mod conversations_http;
mod desktop_broker;
mod desktop_http;
mod execution;
mod execution_accept;
mod execution_registry;
pub mod fast_execution;
pub mod google_registry_metadata;
mod held_inputs;
pub mod host_metrics;
mod intelligence_http;
pub mod live_map;
mod memory_service;
pub mod message_attachments;
mod message_times_http;
pub mod observability;
pub mod offline_python;
pub mod owned_children;
pub mod owned_execution;
mod provider_payload;
mod resource_health;
mod response_shaping;
pub mod restricted_http;
mod routes;
mod sidebar_http;
mod sidebar_v1;
mod steering_http;
mod steering_registry;
pub mod stop_execution;
pub mod thread_icons;
pub mod timer_bootstrap;
pub mod timer_http;
mod timer_lifecycle;
mod v1_links;
mod v1_manage_http;
mod v1_workers_http;
pub mod whatsapp_chats;
mod whatsapp_chats_http;
mod window_http;
mod window_runtime;
mod worker_discovery;
pub mod worker_execution;
pub mod worker_tasks;
mod workspace_exec;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    executions: execution_registry::ExecutionRegistry,
    fast_executions: execution_registry::ExecutionRegistry,
    window_handles: Option<window_runtime::handles::Handles>,
    initial_window: Option<Arc<window_runtime::initial::InitialAuthority>>,
    window_controller: Option<Arc<window_runtime::Controller>>,
    bootstrap_token: Arc<String>,
    origin: Arc<String>,
    authority: Arc<String>,
    auth_window: Arc<Mutex<(Instant, u32)>>,
    resources: resource_health::ResourceSampler,
    timers: timer_http::DurableOwnerController,
    live_map: Option<Arc<std::path::PathBuf>>,
    desktop_broker: Option<Arc<desktop_broker::Broker>>,
    sidebar_v1: sidebar_v1::V1Cache,
    v1_uploads: message_attachments::V1Uploads,
    attachment_export: Option<Arc<message_attachments::ExportDir>>,
    v1_chat_icons: Option<Arc<std::path::PathBuf>>,
    /// "New WhatsApp chat": owner numbers, accounts and the adapter client.
    whatsapp_chats: Option<Arc<whatsapp_chats::WhatsAppChats>>,
    /// Linked V1 timers created per owner request (idempotent create).
    v1_timers: v1_manage_http::CreatedTimers,
    /// Whether this installation can run a conversation's turns on Claude.
    claude_turns: bool,
    /// Restricted-thread broker task and its endpoints (private configuration).
    restricted: Option<Arc<restricted_http::RestrictedRuntime>>,
}
impl AppState {
    pub async fn shutdown_beta_window(&self) -> Result<(), &'static str> {
        match &self.window_controller {
            Some(controller) => controller.shutdown().await,
            None => Ok(()),
        }
    }
    /// Load only the operator-selected private beta configuration at startup.
    pub fn with_beta_config_file(
        self,
        path: &std::path::Path,
        home: &std::path::Path,
    ) -> Result<Self, &'static str> {
        let config = beta_config::loading::load(path, home)?;
        if config
            .host_full_access
            .as_ref()
            .is_some_and(|access| access.providers)
        {
            // Operator opt-in, before any provider session exists.
            orkestr_runtime::provider_access::enable_host_full_access();
        }
        let stat = std::fs::read_to_string("/proc/self/stat")
            .map_err(|_| "beta manager parent unavailable")?;
        let (_, fields) = stat
            .rsplit_once(") ")
            .ok_or("beta manager parent unavailable")?;
        let parent = fields
            .split_whitespace()
            .nth(1)
            .ok_or("beta manager parent unavailable")?
            .parse::<u32>()
            .map_err(|_| "beta manager parent unavailable")?;
        self.with_beta_config(&config, home, parent)
    }

    /// Trusted startup only. Configuration is never accepted from an HTTP body.
    pub(crate) fn with_beta_config(
        mut self,
        config: &beta_config::BetaConfig,
        home: &std::path::Path,
        manager_pid: u32,
    ) -> Result<Self, &'static str> {
        if self.initial_window.is_some() || self.window_handles.is_some() {
            return Err("beta configuration already installed");
        }
        let initial = window_runtime::initial::InitialAuthority::new(config)?;
        let handles = window_runtime::handles::Handles::new(
            config.owner_id.clone(),
            config.conversation_id.clone(),
        )?;
        let initial = Arc::new(initial);
        let manager = window_runtime::manager_client::ManagerClient::new(
            config.manager_socket.clone(),
            config.owner_id.clone(),
            config.conversation_id.clone(),
            manager_pid,
        )
        .map_err(|_| "beta manager identity refused")?;
        let controller = Arc::new(window_runtime::Controller::new(
            config.clone(),
            home.to_owned(),
            self.store.clone(),
            initial.clone(),
            handles.clone(),
            manager,
        ));
        controller.start_dispatcher();
        self.window_controller = Some(controller);
        self.initial_window = Some(initial);
        self.window_handles = Some(handles);
        // An installed Claude window runtime is the Claude turn path for the
        // owner's per-conversation provider setting.
        if config.claude.is_some() {
            self = self.with_claude_turns();
        }
        Ok(self)
    }
    /// Trusted startup only: V1's saved chat icon directory (read-only).
    pub fn with_v1_chat_icons(mut self, dir: std::path::PathBuf) -> Self {
        self.v1_chat_icons = Some(Arc::new(dir));
        self
    }
    /// Trusted startup only: where attached files are written for the provider.
    pub fn with_attachment_export(mut self, export: message_attachments::ExportDir) -> Self {
        self.attachment_export = Some(Arc::new(export));
        self
    }
    /// Trusted startup only: the private V1 desktop broker client configuration.
    pub fn with_desktop_broker_file(
        mut self,
        path: &std::path::Path,
    ) -> Result<Self, &'static str> {
        self.desktop_broker = Some(Arc::new(desktop_broker::Broker::load(path)?));
        Ok(self)
    }
    /// Trusted startup only: the private "New WhatsApp chat" configuration
    /// (owner numbers, accounts, adapter URL and token).
    pub fn with_whatsapp_chats_file(
        mut self,
        path: &std::path::Path,
    ) -> Result<Self, &'static str> {
        self.whatsapp_chats = Some(Arc::new(whatsapp_chats::WhatsAppChats::load(path)?));
        Ok(self)
    }
    /// Trusted startup only: the Claude execution path for conversation turns
    /// is installed, so owners may select Claude in conversation settings.
    pub fn with_claude_turns(mut self) -> Self {
        self.claude_turns = true;
        self
    }
    /// The ordinary server owns the bounded controller task and its shutdown.
    /// With a beta window runtime, every timer occurrence also queues its Deep
    /// turn and wakes the window dispatcher; otherwise only the input is admitted.
    pub fn start_timers(&self, supervisor: Store) -> timer_lifecycle::TimerTask {
        let mut controller = timer_http::durable::DurableTimerController::new(supervisor);
        if let Some(window) = &self.window_controller {
            let window = Arc::downgrade(window);
            controller = controller.with_window_dispatch(Arc::new(move || {
                if let Some(window) = window.upgrade() {
                    window.wake_dispatcher();
                }
            }));
        }
        timer_lifecycle::TimerTask::start(controller, self.timers.ready.clone())
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
            window_handles: None,
            initial_window: None,
            window_controller: None,
            bootstrap_token: Arc::new(bootstrap_token),
            origin: Arc::new(origin),
            authority: Arc::new(authority),
            auth_window: Arc::new(Mutex::new((Instant::now(), 0))),
            resources: resource_health::ResourceSampler::new(),
            live_map: None,
            desktop_broker: None,
            sidebar_v1: sidebar_v1::V1Cache::default(),
            v1_uploads: Default::default(),
            attachment_export: None,
            v1_chat_icons: None,
            whatsapp_chats: None,
            v1_timers: Default::default(),
            claude_turns: false,
            restricted: None,
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
                // The id the observing layer returns in `x-request-id`.
                request_id: observability::request_id()
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
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
    // V1 desktop acquire (and a renewing heartbeat) can take 8-20 s while V1
    // prepares the desktop. Dropping it at 10 s would leave a V1 lease that
    // V2 never recorded, so these two get a longer, still bounded deadline.
    let deadline = if desktop_slow_path(request.uri().path()) {
        Duration::from_secs(60)
    } else {
        Duration::from_secs(10)
    };
    let mut response = match tokio::time::timeout(deadline, next.run(request)).await {
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
/// `/api/v2/conversations/{id}/desktops/{slug}/acquire` or `/heartbeat`.
fn desktop_slow_path(path: &str) -> bool {
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    matches!(
        parts.as_slice(),
        [
            "api",
            "v2",
            "conversations",
            _,
            "desktops",
            _,
            "acquire" | "heartbeat"
        ]
    )
}

#[cfg(test)]
#[test]
fn only_desktop_acquire_and_heartbeat_get_the_long_deadline() {
    assert!(desktop_slow_path(
        "/api/v2/conversations/c/desktops/pa/acquire"
    ));
    assert!(desktop_slow_path(
        "/api/v2/conversations/c/desktops/pa/heartbeat"
    ));
    assert!(!desktop_slow_path(
        "/api/v2/conversations/c/desktops/pa/release"
    ));
    assert!(!desktop_slow_path("/api/v2/conversations/c/desktops"));
    assert!(!desktop_slow_path("/api/v2/conversations/c/messages"));
}

pub fn router(state: AppState) -> Router {
    router_with_google_catalog(state, google_registry_metadata::RegistryCatalog::empty())
}
pub fn router_with_google_catalog(
    state: AppState,
    catalog: google_registry_metadata::RegistryCatalog,
) -> Router {
    Router::new()
        .route("/api/v2/health",get(|| async { Json(serde_json::json!({"status":"ok","product":"orkestr-v2","contract_version":0,"fixture_mode":false,"build":build_identity::identity()})) }))
        .route("/api/v2/setup",get(auth::setup_status).post(auth::setup))
        .route("/api/v2/session",post(auth::session))
        .route("/api/v2/machine/session",post(auth::session))
        .route("/api/v2/browser/session",post(browser::login).get(browser::session).delete(browser::logout))
        .route("/api/v2/projects",get(routes::projects).post(routes::create_project))
        .route("/api/v2/resources",get(resource_health::resources))
        .route("/api/v2/live-map",get(live_map::read))
        .route("/api/v2/conversations/{id}",get(routes::snapshot))
        .route("/api/v2/conversations",get(conversations_http::list).post(conversations_http::create))
        .route("/api/v2/conversations/{id}/accepted-results",get(accepted_results_http::read))
        .route("/api/v2/beta",get(beta_discovery_http::read))
        .route("/api/v2/conversations/{id}/intelligence",get(intelligence_http::read))
        .route("/api/v2/conversations/{id}/window",get(window_http::status).post(window_http::admit))
        .route("/api/v2/conversations/{id}/window/queue",get(window_http::queue))
        .route("/api/v2/conversations/{id}/window/reconcile",post(window_http::reconcile))
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
        .nest("/api/v2",attachment_transfer::router())
        .nest("/api/v2",automatic_reply_control::router())
        .merge(memory_service::router(state.clone()))
        .merge(archived_history_http::router())
        .merge(conversation_resources_http::router())
        .merge(conversation_status_http::router())
        .merge(host_metrics::router())
        .merge(desktop_http::router())
        .merge(sidebar_http::router())
        .merge(message_attachments::router())
        .merge(attachment_keys_http::router())
        .merge(message_times_http::router())
        .merge(conversation_posts_http::router())
        .merge(thread_icons::router())
        .merge(v1_links::router())
        .merge(v1_manage_http::router())
        .merge(v1_workers_http::router())
        .merge(whatsapp_chats_http::router())
        .merge(restricted_http::router())
        .merge(google_registry_metadata::router(catalog))
        // Labels each matched request with its route template for logs and metrics.
        .route_layer(middleware::from_fn(observability::record_route))
        .fallback(|| async { Error(StatusCode::NOT_FOUND,"not_found","Endpoint not found") })
        .layer(DefaultBodyLimit::max(40 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(),guard))
        .layer(middleware::from_fn(response_shaping::shape))
        .with_state(state)
}
