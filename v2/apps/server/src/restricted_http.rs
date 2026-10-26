//! Restricted threads: owner-facing policy, approvals, audit and transcript routes,
//! and the private configuration that installs the broker task. The model never
//! reaches any of these routes: it has no network and no credential, and its only
//! output is parsed by the broker.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::{conversation, failure, invalid};
use axum::extract::{rejection::JsonRejection, Path, Query};
use orkestr_v2_restricted::{
    agent::{Endpoints, Runner},
    broker::{Backends, Broker, BrokerConfig, NoChannel},
    llm::CurlChat,
    sandbox::DockerSandbox,
    web::{CurlFetcher, JsonSearch, Searcher, Unconfigured},
};
use serde::Deserialize;
use std::path::PathBuf;

pub const CONFIG_ENV: &str = "ORKESTR_V2_RESTRICTED_CONFIG";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v2/conversations/{id}/restricted",
            get(thread).put(update),
        )
        .route(
            "/api/v2/conversations/{id}/restricted/session/reset",
            post(reset_session),
        )
        .route(
            "/api/v2/conversations/{id}/restricted/approvals",
            get(approvals),
        )
        .route(
            "/api/v2/conversations/{id}/restricted/approvals/{approval}",
            post(decide),
        )
        .route("/api/v2/conversations/{id}/restricted/audit", get(audit))
        .route(
            "/api/v2/conversations/{id}/restricted/messages",
            get(messages),
        )
}

async fn thread(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .restricted_thread(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<RestrictedThreadUpdate>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Json(update) = body.map_err(|_| invalid())?;
    if update.enabled && state.restricted.is_none() {
        return Err(Error(
            StatusCode::CONFLICT,
            "restricted_unconfigured",
            "Restricted threads are not configured on this installation",
        ));
    }
    let value = state
        .store
        .update_restricted_thread(&credential, &owner, &conversation(&id)?, &update)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn reset_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    state
        .store
        .reset_restricted_session(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ApprovalQuery {
    #[serde(default)]
    pending: bool,
}
async fn approvals(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<ApprovalQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Query(query) = query.map_err(|_| invalid())?;
    let value = state
        .store
        .restricted_approvals(&credential, &owner, &conversation(&id)?, query.pending)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn decide(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, approval)): Path<(String, String)>,
    body: Result<Json<RestrictedApprovalDecision>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Json(decision) = body.map_err(|_| invalid())?;
    if Uuid::parse_str(&approval).is_err() {
        return Err(invalid());
    }
    let value = state
        .store
        .decide_restricted_approval(
            &credential,
            &owner,
            &conversation(&id)?,
            &approval,
            &decision,
        )
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct PageQuery {
    before: Option<i64>,
    after: Option<i64>,
    limit: Option<u32>,
}
async fn audit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<PageQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Query(q) = query.map_err(|_| invalid())?;
    let value = state
        .store
        .restricted_audit_page(
            &credential,
            &owner,
            &conversation(&id)?,
            q.before,
            q.limit.unwrap_or(50),
        )
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<PageQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Query(q) = query.map_err(|_| invalid())?;
    let value = state
        .store
        .restricted_messages_page(
            &credential,
            &owner,
            &conversation(&id)?,
            q.after.unwrap_or(0),
            q.limit.unwrap_or(50),
        )
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

// ---- private configuration ---------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EndpointConfig {
    base_url: String,
    /// Name of the environment variable that holds the API key (never the key itself).
    #[serde(default)]
    api_key_env: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default = "default_call_secs")]
    timeout_secs: u64,
}
fn default_call_secs() -> u64 {
    120
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestrictedConfig {
    endpoints: std::collections::HashMap<String, EndpointConfig>,
    /// e.g. ["docker"] or ["sudo","-n","docker"]. Absent: the sandbox is unavailable.
    #[serde(default)]
    docker: Vec<String>,
    #[serde(default = "default_network")]
    sandbox_network: String,
    #[serde(default)]
    search_url: Option<String>,
    #[serde(default)]
    deny_roots: Vec<PathBuf>,
    #[serde(default = "default_approval_secs")]
    approval_timeout_secs: u64,
    /// Host helper that starts the GPU after the owner approves (`orkestr-llm`).
    #[serde(default)]
    gpu: Option<GpuConfig>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GpuConfig {
    /// Absolute path of the helper. The helper enforces every cost rule itself.
    command: String,
}
fn default_network() -> String {
    "bridge".into()
}
fn default_approval_secs() -> u64 {
    900
}

pub struct RestrictedRuntime {
    runner: Arc<Runner>,
}
pub struct RestrictedTask {
    stop: tokio::sync::watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}
impl RestrictedTask {
    pub async fn shutdown(self) {
        let _ = self.stop.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), self.handle).await;
    }
}

impl RestrictedRuntime {
    pub(crate) fn load(store: &Store, path: &std::path::Path) -> Result<Self, &'static str> {
        use std::os::unix::fs::MetadataExt;
        let md = std::fs::metadata(path).map_err(|_| "restricted config unavailable")?;
        if !md.is_file() || md.mode() & 0o022 != 0 || md.len() > 64 * 1024 {
            return Err("restricted config must be a private regular file");
        }
        let config: RestrictedConfig = serde_json::from_slice(
            &std::fs::read(path).map_err(|_| "restricted config unreadable")?,
        )
        .map_err(|_| "restricted config invalid")?;
        let mut endpoints = Endpoints::new();
        for (name, e) in config.endpoints {
            if !orkestr_v2_contracts::restricted_name_valid(&name)
                || !(e.base_url.starts_with("https://") || e.base_url.starts_with("http://"))
                || e.base_url
                    .chars()
                    .any(|c| c.is_control() || c.is_whitespace())
            {
                return Err("restricted endpoint invalid");
            }
            let api_key = match &e.api_key_env {
                Some(var) => Some(
                    std::env::var(var)
                        .ok()
                        .filter(|k| !k.is_empty() && !k.chars().any(|c| c.is_control()))
                        .ok_or("restricted endpoint key variable is not set")?,
                ),
                None => None,
            };
            endpoints.insert(
                name,
                Arc::new(CurlChat {
                    base_url: e.base_url,
                    api_key,
                    default_model: e.model,
                    timeout: Duration::from_secs(e.timeout_secs.clamp(5, 600)),
                }) as _,
            );
        }
        let gpu: Arc<dyn orkestr_v2_restricted::broker::GpuControl> = match config.gpu {
            Some(g)
                if g.command.starts_with('/')
                    && !g
                        .command
                        .chars()
                        .any(|c| c.is_control() || c.is_whitespace()) =>
            {
                Arc::new(orkestr_v2_restricted::gpu::CliGpu { command: g.command })
            }
            Some(_) => return Err("restricted gpu command must be an absolute path"),
            None => Arc::new(NoChannel),
        };
        let docker = config.docker;
        let searcher: Arc<dyn Searcher> = match config.search_url {
            Some(base) => Arc::new(JsonSearch { base }),
            None => Arc::new(Unconfigured("web search")),
        };
        let backends = Backends {
            sandbox: Arc::new(DockerSandbox::new(docker)),
            fetcher: Arc::new(CurlFetcher),
            searcher,
            sender: Arc::new(NoChannel),
            gpu,
        };
        let broker_config = BrokerConfig {
            deny_roots: config.deny_roots,
            approval_timeout: Duration::from_secs(
                config.approval_timeout_secs.clamp(30, 24 * 3600),
            ),
            sandbox_network: config.sandbox_network,
            ..Default::default()
        };
        let broker = Arc::new(Broker {
            store: store.clone(),
            config: broker_config,
            backends,
        });
        Ok(Self {
            runner: Arc::new(Runner {
                store: store.clone(),
                broker,
                endpoints,
                poll: Duration::from_secs(1),
            }),
        })
    }
}

impl AppState {
    /// Trusted startup only: the private restricted-thread configuration.
    pub fn with_restricted_config_file(
        mut self,
        path: &std::path::Path,
    ) -> Result<Self, &'static str> {
        self.restricted = Some(Arc::new(RestrictedRuntime::load(&self.store, path)?));
        Ok(self)
    }
    pub fn start_restricted(&self) -> Option<RestrictedTask> {
        let runtime = self.restricted.as_ref()?;
        let (stop, rx) = tokio::sync::watch::channel(false);
        Some(RestrictedTask {
            stop,
            handle: tokio::spawn(runtime.runner.clone().run(rx)),
        })
    }
}

#[cfg(test)]
#[path = "restricted_http_tests.rs"]
mod tests;
