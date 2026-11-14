//! The owner's credentials page (ORK-826, `docs/v2/credentials.md`):
//! passwords, tokens and API keys the owner's chats and desks may use.
//!
//! One API over a store chosen at startup (`backend`): the built-in vault by
//! default, or OpenBao. Every route needs the owner's password-signed-in
//! browser session (a service session is refused, as for the vault); the
//! router's guard enforces Origin, Host and CSRF for every change. Answers
//! carry metadata, usage and fixed codes, never a value: revealing one value
//! is the browser's own key (built-in vault) or the store's own UI under the
//! owner's sign-in (OpenBao), both outside these routes.
use super::*;
use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query,
    },
    routing::{patch, put},
};
use model::{CreateRequest, CredentialView, DeleteQuery, Kind, UpdateRequest, ValueReplace};
use openbao::BaoError;
use usage::Summary;

mod backend;
mod catalog;
mod loopback;
mod model;
mod openbao;
mod private_file;
#[cfg(test)]
mod tests;
mod usage;
mod v2_vault;

pub(crate) use backend::Backend;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/credentials", get(list).post(create))
        .route("/api/v2/credentials/{id}", patch(update).delete(remove))
        .route("/api/v2/credentials/{id}/value", put(replace_value))
}

impl AppState {
    /// Trusted startup only: the credentials store selected by the operator.
    pub fn with_credentials_backend(mut self, home: &std::path::Path) -> Self {
        self.credentials = Backend::load(home);
        self
    }
    /// Which store the credentials page manages, for one startup log line.
    pub fn credentials_backend(&self) -> &'static str {
        self.credentials.name()
    }
    /// Why the credentials configuration file was refused, if it was.
    pub fn credentials_backend_rejection(&self) -> Option<&'static str> {
        self.credentials.rejection()
    }
    #[cfg(test)]
    pub(crate) fn with_credentials(mut self, backend: Backend) -> Self {
        self.credentials = backend;
        self
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn invalid(code: &'static str) -> Error {
    Error(StatusCode::UNPROCESSABLE_ENTITY, code, model::message(code))
}
fn request_invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "credential_request_invalid",
        "Invalid credential request",
    )
}
fn store(error: BaoError) -> Error {
    match error {
        BaoError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "credentials_backend_unavailable",
            model::message("credentials_backend_unavailable"),
        ),
        BaoError::RateLimited => Error(
            StatusCode::TOO_MANY_REQUESTS,
            "credentials_rate_limited",
            model::message("credentials_rate_limited"),
        ),
        BaoError::Refused => Error(
            StatusCode::BAD_GATEWAY,
            "credentials_backend_refused",
            model::message("credentials_backend_refused"),
        ),
        BaoError::NotFound => Error(
            StatusCode::NOT_FOUND,
            "credential_not_found",
            model::message("credential_not_found"),
        ),
        BaoError::Changed => Error(
            StatusCode::CONFLICT,
            "credential_changed",
            model::message("credential_changed"),
        ),
        BaoError::Invalid(code) => invalid(code),
    }
}
fn unconfigured() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "credentials_backend_unconfigured",
        model::message("credentials_backend_unconfigured"),
    )
}
fn vault(error: orkestr_v2_store_sqlite::vault::VaultError) -> Error {
    crate::vault_http::failure(error)
}
fn json<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    body.map(|Json(v)| v).map_err(|_| request_invalid())
}
fn no_store(status: StatusCode, value: impl serde::Serialize) -> Response {
    let mut response = ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response();
    *response.status_mut() = status;
    response
}

/// The exact credential of a password-signed-in owner browser session.
async fn session(state: &AppState, headers: &HeaderMap) -> Result<String, Error> {
    browser::owner(state, headers).await?;
    let credential = browser::credential(headers)?;
    state.store.vault_owner(&credential).await.map_err(vault)?;
    Ok(credential)
}

fn reader(state: &AppState) -> Option<&str> {
    state.vault_reader.ready().map(|r| r.recipient.as_str())
}

/// What the page may offer for the selected store.
fn capabilities(backend: &Backend) -> serde_json::Value {
    match backend {
        Backend::OpenBao { client, .. } => serde_json::json!({
            "types": ["password", "token", "api_key"],
            "grant_ids": "conversation",
            "owner_desks_editable": true,
            "site_with_value": false,
            "value_replace": "fields",
            "reveal": if client.reveal_url().is_some() { "external" } else { "none" },
            "reveal_url": client.reveal_url(),
            "vault_import": false,
        }),
        _ => serde_json::json!({
            "types": ["password", "token", "api_key"],
            "grant_ids": "v1_thread",
            "owner_desks_editable": false,
            "site_with_value": true,
            "value_replace": "whole",
            "reveal": "browser",
            "reveal_url": null,
            "vault_import": true,
        }),
    }
}

fn with_usage(mut row: CredentialView, summary: &Summary) -> CredentialView {
    row.usage = summary.of(&row.id);
    row
}

async fn list(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    let credential = session(&state, &headers).await?;
    let now = now_ms();
    let mut summary = state
        .credentials
        .usage_path()
        .map(Summary::load)
        .unwrap_or_default();
    let from_summary = summary.generated_at_ms;
    let (rows, truncated, catalog_at) = match &state.credentials {
        Backend::V2Vault { .. } => {
            let vault_view = v2_vault::Vault {
                store: &state.store,
                credential: &credential,
                reader: reader(&state),
            };
            (
                vault_view.list(&mut summary).await.map_err(vault)?,
                false,
                None,
            )
        }
        Backend::OpenBao { client, .. } => {
            let listing = client.list().await.map_err(store)?;
            (listing.rows, listing.truncated, listing.catalog_at_ms)
        }
        Backend::Refused(_) => return Err(unconfigured()),
    };
    let mut rows: Vec<CredentialView> = rows.into_iter().map(|r| with_usage(r, &summary)).collect();
    rows.sort_by(|a, b| {
        a.label
            .to_lowercase()
            .cmp(&b.label.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
    // The built-in vault reports its own uses live; a summary may lag.
    let stale = match from_summary {
        Some(_) => summary.stale(now),
        None => matches!(state.credentials, Backend::OpenBao { .. }),
    };
    Ok(no_store(
        StatusCode::OK,
        serde_json::json!({
            "schema_version": 1,
            "backend": state.credentials.name(),
            "capabilities": capabilities(&state.credentials),
            "credentials": rows,
            "truncated": truncated,
            "catalog_at_ms": catalog_at,
            "usage": {"observed_at_ms": from_summary, "stale": stale},
        }),
    ))
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<CreateRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let credential = session(&state, &headers).await?;
    let request = json(body)?;
    let kind = Kind::parse(&request.kind).ok_or_else(|| invalid("credential_type_invalid"))?;
    let label = model::label(&request.label).map_err(invalid)?;
    let site = model::site(&request.site).map_err(invalid)?;
    if kind == Kind::Password && site.is_empty() {
        return Err(invalid("credential_site_required"));
    }
    let fields = request.value.fields(kind, true).map_err(invalid)?;
    let row = match &state.credentials {
        Backend::V2Vault { .. } => {
            let allowed = model::allowed(&request.allowed, true).map_err(invalid)?;
            let vault_view = v2_vault::Vault {
                store: &state.store,
                credential: &credential,
                reader: reader(&state),
            };
            let new = v2_vault::NewCredential {
                kind,
                label: &label,
                site: &site,
                allowed: &allowed,
                fields: &fields,
            };
            vault_view.create(new).await.map_err(vault)?
        }
        Backend::OpenBao { client, .. } => {
            let allowed = model::allowed(&request.allowed, false).map_err(invalid)?;
            client
                .create(kind, &label, &site, &allowed, request.owner_desks, &fields)
                .await
                .map_err(store)?
        }
        Backend::Refused(_) => return Err(unconfigured()),
    };
    let summary = state
        .credentials
        .usage_path()
        .map(Summary::load)
        .unwrap_or_default();
    Ok(no_store(StatusCode::CREATED, with_usage(row, &summary)))
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<UpdateRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let credential = session(&state, &headers).await?;
    let request = json(body)?;
    let label = request
        .label
        .as_deref()
        .map(model::label)
        .transpose()
        .map_err(invalid)?;
    let site = request
        .site
        .as_deref()
        .map(model::site)
        .transpose()
        .map_err(invalid)?;
    let row = match &state.credentials {
        Backend::V2Vault { .. } => {
            let vault_view = v2_vault::Vault {
                store: &state.store,
                credential: &credential,
                reader: reader(&state),
            };
            let current = vault_view.current(&id).await.map_err(vault)?;
            if site.as_ref().is_some_and(|s| *s != current.site) {
                return Err(invalid("credential_site_needs_value"));
            }
            if request
                .owner_desks
                .is_some_and(|d| d != current.owner_desks)
            {
                return Err(invalid("credential_owner_desks_fixed"));
            }
            let allowed = request
                .allowed
                .as_deref()
                .map(|a| model::allowed(a, true))
                .transpose()
                .map_err(invalid)?;
            vault_view
                .update(
                    &id,
                    &request.expected_revision,
                    label.as_deref(),
                    allowed.as_deref(),
                )
                .await
                .map_err(vault)?
        }
        Backend::OpenBao { client, .. } => {
            let allowed = request
                .allowed
                .as_deref()
                .map(|a| model::allowed(a, false))
                .transpose()
                .map_err(invalid)?;
            client
                .update(
                    &id,
                    &request.expected_revision,
                    label.as_deref(),
                    site.as_deref(),
                    allowed.as_deref(),
                    request.owner_desks,
                )
                .await
                .map_err(store)?
        }
        Backend::Refused(_) => return Err(unconfigured()),
    };
    let summary = state
        .credentials
        .usage_path()
        .map(Summary::load)
        .unwrap_or_default();
    Ok(no_store(StatusCode::OK, with_usage(row, &summary)))
}

async fn replace_value(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ValueReplace>, JsonRejection>,
) -> Result<Response, Error> {
    let credential = session(&state, &headers).await?;
    let request = json(body)?;
    let row = match &state.credentials {
        Backend::V2Vault { .. } => {
            let vault_view = v2_vault::Vault {
                store: &state.store,
                credential: &credential,
                reader: reader(&state),
            };
            let current = vault_view.current(&id).await.map_err(vault)?;
            let site = match request.site.as_deref() {
                Some(site) => model::site(site).map_err(invalid)?,
                None => current.site.clone(),
            };
            if current.kind == Kind::Password && site.is_empty() {
                return Err(invalid("credential_site_required"));
            }
            // The vault replaces the whole login, so its main value is required.
            let fields = request.value.fields(current.kind, true).map_err(invalid)?;
            vault_view
                .replace_value(
                    &id,
                    &request.expected_revision,
                    &site,
                    current.kind,
                    &fields,
                )
                .await
                .map_err(vault)?
        }
        Backend::OpenBao { client, .. } => {
            if request.site.is_some() {
                return Err(request_invalid()); // the site is metadata here: PATCH it
            }
            let current = client.current(&id).await.map_err(store)?;
            let fields = request.value.fields(current.kind, false).map_err(invalid)?;
            client
                .replace_value(&id, &request.expected_revision, &fields)
                .await
                .map_err(store)?
        }
        Backend::Refused(_) => return Err(unconfigured()),
    };
    let summary = state
        .credentials
        .usage_path()
        .map(Summary::load)
        .unwrap_or_default();
    Ok(no_store(StatusCode::OK, with_usage(row, &summary)))
}

async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<DeleteQuery>, QueryRejection>,
) -> Result<Response, Error> {
    let credential = session(&state, &headers).await?;
    let Query(query) = query.map_err(|_| request_invalid())?;
    match &state.credentials {
        Backend::V2Vault { .. } => {
            let vault_view = v2_vault::Vault {
                store: &state.store,
                credential: &credential,
                reader: reader(&state),
            };
            vault_view
                .delete(&id, &query.expected_revision)
                .await
                .map_err(vault)?
        }
        Backend::OpenBao { client, .. } => client
            .delete(&id, &query.expected_revision)
            .await
            .map_err(store)?,
        Backend::Refused(_) => return Err(unconfigured()),
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
