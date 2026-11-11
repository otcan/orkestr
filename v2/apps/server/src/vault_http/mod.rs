//! Owner credential vault routes (ORK-784, `docs/v2/vault.md`).
//!
//! Owner routes need a password-signed-in browser session; the router's
//! guard enforces Origin, Host and CSRF for every mutation. The stored-login
//! read (`reader`) takes the reader credential from the trusted startup
//! configuration instead. Responses carry metadata or ciphertext, never a
//! value, and errors carry fixed codes.
use super::*;
use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        DefaultBodyLimit, Path, Query,
    },
    routing::{patch, put},
};
use orkestr_v2_store_sqlite::vault::{
    GrantsReplace, ImportRequest, ItemCreate, ItemUpdate, LoginReplace, VaultError,
};

pub(crate) mod reader;
pub(crate) use reader::ReaderState;
#[cfg(test)]
mod tests;

/// The import carries up to 500 logins; every other vault route keeps the
/// router's 40 KiB limit.
const IMPORT_BODY_MAX: usize = 2 * 1024 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/vault", get(status))
        .route("/api/v2/vault/items", get(list).post(create))
        .route("/api/v2/vault/items/{id}", patch(update).delete(remove))
        .route("/api/v2/vault/items/{id}/login", put(replace_login))
        .route("/api/v2/vault/items/{id}/grants", put(set_grants))
        .route("/api/v2/vault/items/{id}/sealed", get(sealed))
        .route("/api/v2/vault/audit", get(audit))
        .route("/api/v2/vault/stored-login", post(reader::stored_login))
        .merge(
            Router::new()
                .route("/api/v2/vault/import", post(import))
                .layer(DefaultBodyLimit::max(IMPORT_BODY_MAX)),
        )
}

pub(crate) fn failure(error: VaultError) -> Error {
    match error {
        VaultError::Invalid(
            code @ ("vault_address_required" | "vault_address_not_https" | "vault_address_invalid"),
        ) => Error(StatusCode::UNPROCESSABLE_ENTITY, code, message(code)),
        VaultError::Invalid(code) => Error(StatusCode::BAD_REQUEST, code, message(code)),
        VaultError::Unauthorized => unauthorized(),
        VaultError::NotFound(code) => Error(StatusCode::NOT_FOUND, code, message(code)),
        VaultError::Conflict(code) => Error(StatusCode::CONFLICT, code, message(code)),
        VaultError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Storage unavailable",
        ),
    }
}
/// Owner-facing text for each code. Never derived from the request.
fn message(code: &str) -> &'static str {
    match code {
        "vault_name_required" => "A name is required",
        "vault_address_required" => {
            "An address is required: a stored login is only used on the site it names"
        }
        "vault_address_not_https" => "The address must start with https://",
        "vault_address_invalid" => "The address needs a valid web host, like https://example.com",
        "vault_url_invalid" => "The address is not a plain web address",
        "vault_item_changed" => "This login changed meanwhile; reload and try again",
        "vault_item_not_found" => "Login not found",
        "vault_recipient_required" => {
            "Nothing can open this login yet: reload the app to enrol this browser"
        }
        "vault_item_single_use" => "A single-use login cannot be replaced",
        "vault_full" => "The vault is full",
        "vault_import_format_invalid" | "vault_import_size_invalid" => {
            "The import file is not an Orkestr vault import"
        }
        "vault_import_duplicate_source" => "The import names one login twice",
        "no_credential_for_site" => "No stored login for this site",
        "credential_ambiguous" => "More than one stored login matches this site",
        "credential_not_sealed_for_reader" => "This login is not available to stored login",
        "desk_lease_required" => "The desk lease is not held",
        _ => "Invalid vault request",
    }
}
fn json<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    body.map(|Json(v)| v).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "vault_request_invalid",
            "Invalid vault request",
        )
    })
}
/// The exact browser credential of a signed-in owner. The store also requires
/// that the session was opened with the password (`kind='browser'`).
async fn browser_credential(state: &AppState, headers: &HeaderMap) -> Result<String, Error> {
    browser::owner(state, headers).await?;
    browser::credential(headers)
}
fn reader_recipient(state: &AppState) -> Option<&str> {
    state.vault_reader.ready().map(|r| r.recipient.as_str())
}
fn no_store(value: impl serde::Serialize) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    let credential = browser_credential(&state, &headers).await?;
    let status = state
        .store
        .vault_status(&credential, reader_recipient(&state))
        .await
        .map_err(failure)?;
    let mut value = serde_json::to_value(status).map_err(|_| failure(VaultError::Unavailable))?;
    value["stored_login"] = serde_json::json!(state.vault_reader.label());
    Ok(no_store(value))
}
async fn list(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    let credential = browser_credential(&state, &headers).await?;
    let items = state
        .store
        .vault_items(&credential, reader_recipient(&state))
        .await
        .map_err(failure)?;
    Ok(no_store(serde_json::json!({ "items": items })))
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<ItemCreate>, JsonRejection>,
) -> Result<Response, Error> {
    let credential = browser_credential(&state, &headers).await?;
    let input = json(body)?;
    let item = state
        .store
        .vault_create(&credential, reader_recipient(&state), &input)
        .await
        .map_err(failure)?;
    let mut response = no_store(item);
    *response.status_mut() = StatusCode::CREATED;
    Ok(response)
}
async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ItemUpdate>, JsonRejection>,
) -> Result<Response, Error> {
    let credential = browser_credential(&state, &headers).await?;
    let input = json(body)?;
    let item = state
        .store
        .vault_update(&credential, reader_recipient(&state), &id, &input)
        .await
        .map_err(failure)?;
    Ok(no_store(item))
}
async fn replace_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<LoginReplace>, JsonRejection>,
) -> Result<Response, Error> {
    let credential = browser_credential(&state, &headers).await?;
    let input = json(body)?;
    let item = state
        .store
        .vault_replace_login(&credential, reader_recipient(&state), &id, &input)
        .await
        .map_err(failure)?;
    Ok(no_store(item))
}
async fn set_grants(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<GrantsReplace>, JsonRejection>,
) -> Result<Response, Error> {
    let credential = browser_credential(&state, &headers).await?;
    let input = json(body)?;
    let item = state
        .store
        .vault_set_grants(&credential, reader_recipient(&state), &id, &input)
        .await
        .map_err(failure)?;
    Ok(no_store(item))
}
async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let credential = browser_credential(&state, &headers).await?;
    state
        .store
        .vault_delete(&credential, &id)
        .await
        .map_err(failure)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
async fn sealed(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let credential = browser_credential(&state, &headers).await?;
    let sealed = state
        .store
        .vault_sealed(&credential, &id)
        .await
        .map_err(failure)?;
    Ok(no_store(sealed))
}
async fn import(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<ImportRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let credential = browser_credential(&state, &headers).await?;
    let request = json(body)?;
    let report = state
        .store
        .vault_import(&credential, reader_recipient(&state), &request)
        .await
        .map_err(failure)?;
    Ok(no_store(report))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AuditQuery {
    limit: Option<i64>,
}
async fn audit(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<AuditQuery>, QueryRejection>,
) -> Result<Response, Error> {
    let credential = browser_credential(&state, &headers).await?;
    let Query(query) = query.map_err(|_| failure(VaultError::Invalid("vault_request_invalid")))?;
    let events = state
        .store
        .vault_audit(&credential, query.limit.unwrap_or(100))
        .await
        .map_err(failure)?;
    Ok(no_store(serde_json::json!({ "events": events })))
}
