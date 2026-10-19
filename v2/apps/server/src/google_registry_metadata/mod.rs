//! Native isolated leaf. Coordinator owns shared registration and trusted bindings.
pub mod catalog_config;
mod reader;
mod strict_json;
use crate::AppState;
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, RawQuery, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Extension, Json, Router,
};
use orkestr_v2_contracts::OwnerId;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Component, PathBuf},
    sync::Arc,
};

pub const ROUTE: &str = "/api/v2/connectors/google/registry-metadata";
/// Trusted configuration, never request/registry-derived authentication.
#[derive(Clone)]
pub struct RegistryBinding {
    pub owner: OwnerId,
    pub legacy_registry_owner: String,
    pub path: PathBuf,
}
#[derive(Clone)]
pub struct RegistryCatalog {
    bindings: Arc<HashMap<OwnerId, RegistryBinding>>,
    #[cfg(all(test, target_os = "linux"))]
    pause: Option<Arc<tests::Pause>>,
}
impl RegistryCatalog {
    pub fn empty() -> Self {
        Self {
            bindings: Arc::new(HashMap::new()),
            #[cfg(all(test, target_os = "linux"))]
            pause: None,
        }
    }
    /// Explicit one-to-one binding, including when legacy/V2 identities differ.
    /// No filesystem lookup, canonicalization, initialization or global fallback.
    pub fn new(bindings: Vec<RegistryBinding>) -> Result<Self, &'static str> {
        let mut owners = HashMap::new();
        let mut paths = HashSet::new();
        for binding in bindings {
            if binding.owner.0.is_nil()
                || binding.legacy_registry_owner.is_empty()
                || binding.legacy_registry_owner.len() > 256
                || binding.legacy_registry_owner.trim() != binding.legacy_registry_owner
                || binding.legacy_registry_owner.chars().any(char::is_control)
                || !binding.path.is_absolute()
                || binding.path.file_name().and_then(|s| s.to_str())
                    != Some("google-workspace-connections.json")
                || binding
                    .path
                    .components()
                    .skip(1)
                    .any(|c| !matches!(c, Component::Normal(_)))
                || !paths.insert(binding.path.clone())
                || owners.contains_key(&binding.owner)
            {
                return Err("explicit unique owner registry binding required");
            }
            owners.insert(binding.owner.clone(), binding);
        }
        Ok(Self {
            bindings: Arc::new(owners),
            #[cfg(all(test, target_os = "linux"))]
            pause: None,
        })
    }
}
/// Merge before the coordinator's ordinary guard/state layers. No registration here.
pub fn router(catalog: RegistryCatalog) -> Router<AppState> {
    Router::new()
        .route(ROUTE, any(handle))
        .layer(DefaultBodyLimit::max(1))
        .layer(Extension(catalog))
}
#[derive(Clone, Copy)]
struct Refused(StatusCode, &'static str);
impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        response(
            self.0,
            json!({"format_version":1,"status":"refused","error":self.1}),
        )
    }
}
fn response(status: StatusCode, value: Value) -> Response {
    let mut response = (status, Json(value)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    if status == StatusCode::METHOD_NOT_ALLOWED {
        response
            .headers_mut()
            .insert(header::ALLOW, "GET".parse().unwrap());
    }
    response
}
fn single<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        None
    } else {
        Some(value)
    }
}
fn validate(
    state: &AppState,
    headers: &HeaderMap,
    query: Option<&str>,
    body: &[u8],
) -> Result<String, Refused> {
    let bad = || Refused(StatusCode::BAD_REQUEST, "request_parameters_rejected");
    if query.is_some_and(|q| !q.is_empty())
        || !body.is_empty()
        || headers.contains_key("transfer-encoding")
        || ["x-owner-id", "x-account-id", "x-user-id", "x-registry-path"]
            .iter()
            .any(|key| headers.contains_key(*key))
        || headers.len() > 128
        || headers
            .iter()
            .map(|(k, v)| k.as_str().len() + v.as_bytes().len())
            .sum::<usize>()
            > 32768
        || headers
            .iter()
            .any(|(k, v)| k.as_str().len() + v.as_bytes().len() > 16384)
        || headers
            .get_all(header::CONTENT_LENGTH)
            .iter()
            .any(|v| v != "0")
    {
        return Err(bad());
    }
    if single(headers, "host") != Some(state.authority.as_str()) {
        return Err(Refused(StatusCode::FORBIDDEN, "host_rejected"));
    }
    if headers.contains_key(header::ORIGIN)
        && single(headers, "origin") != Some(state.origin.as_str())
    {
        return Err(Refused(StatusCode::FORBIDDEN, "origin_rejected"));
    }
    // Reuse the canonical parser, including duplicate cookies and Bearer refusal.
    crate::browser::credential(headers)
        .map_err(|_| Refused(StatusCode::UNAUTHORIZED, "authentication_required"))
}
async fn current(
    state: &AppState,
    credential: &str,
    expected: Option<&OwnerId>,
) -> Result<OwnerId, Refused> {
    let owner = state
        .store
        .authenticate(credential)
        .await
        .map_err(|_| Refused(StatusCode::SERVICE_UNAVAILABLE, "authority_unavailable"))?
        .ok_or(Refused(StatusCode::UNAUTHORIZED, "authentication_required"))?;
    if expected.is_some_and(|expected| expected != &owner) {
        return Err(Refused(StatusCode::FORBIDDEN, "owner_scope_changed"));
    }
    Ok(owner)
}
async fn handle(
    State(state): State<AppState>,
    Extension(catalog): Extension<RegistryCatalog>,
    method: Method,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Result<Response, Refused> {
    if method != Method::GET {
        return Err(Refused(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
        ));
    }
    let credential = validate(&state, &headers, query.as_deref(), &body)?;
    let owner = current(&state, &credential, None).await?;
    let binding = catalog.bindings.get(&owner).cloned().ok_or(Refused(
        StatusCode::SERVICE_UNAVAILABLE,
        "registry_unavailable",
    ))?;
    #[cfg(all(test, target_os = "linux"))]
    tests::pause(&catalog, tests::Stage::BeforeRead).await;
    current(&state, &credential, Some(&owner)).await?;
    let value = tokio::task::spawn_blocking(move || {
        reader::metadata(&binding.path, &binding.legacy_registry_owner)
    })
    .await
    .map_err(|_| Refused(StatusCode::SERVICE_UNAVAILABLE, "registry_unavailable"))?
    .map_err(|_| Refused(StatusCode::SERVICE_UNAVAILABLE, "registry_unavailable"))?;
    #[cfg(all(test, target_os = "linux"))]
    tests::pause(&catalog, tests::Stage::BeforeDelivery).await;
    current(&state, &credential, Some(&owner)).await?;
    Ok(response(
        StatusCode::OK,
        json!({"format_version":1,"status":"configuration_observed","metadata":value}),
    ))
}
#[cfg(all(test, target_os = "linux"))]
mod tests;
