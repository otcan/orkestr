//! Local folder relay (ORK-750, proof of concept). See
//! `docs/v2/local-files.md`.
//!
//! Owner (browser cookie with CSRF, or machine bearer), for provisioning:
//! - `GET|PUT|DELETE /api/v2/conversations/{id}/local-files-grant`: read,
//!   issue/rotate (shown once) or revoke the conversation's grant.
//!
//! The owner's browser tab (an interactive browser session only: never a
//! machine bearer or a service credential; CSRF on every write):
//! - `GET  .../local-files?limit=N`: grant state, connection, request log.
//! - `POST .../local-files/poll`: heartbeat; takes the queued requests.
//! - `POST .../local-files/disconnect`: this tab stops serving the folder.
//! - `GET  .../local-files/requests/{request}/content?connection_id=ID`:
//!   the bytes of a write this tab holds.
//! - `POST .../local-files/requests/{request}/result`: the tab's result.
//!   A read or package names its completed encrypted upload; the server
//!   checks that upload itself and never takes file bytes in this JSON.
//!
//! Grant holder (header `x-orkestr-local-files-grant`, machine requests
//! only, never with a cookie, bearer or Origin):
//! - `POST .../local-files/requests`: queue one request (202, or 200 for a
//!   replay); `409 local_files_not_connected` without a connected tab.
//! - `GET  .../local-files/requests/{request}`: its state and result.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::conversation;
use axum::extract::{
    rejection::{JsonRejection, QueryRejection},
    Path, Query,
};
use orkestr_v2_store_sqlite::ResourceError;

/// A write's base64 content plus the request around it.
const CREATE_BODY_MAX: usize = LOCAL_FILE_WRITE_MAX.div_ceil(3) * 4 + 16 * 1024;
/// A listing of `LOCAL_FILE_LIST_MAX` entries with long names.
const RESULT_BODY_MAX: usize = 512 * 1024;

pub(crate) fn router() -> Router<AppState> {
    let base = "/api/v2/conversations/{id}";
    let create = Router::new()
        .route(&format!("{base}/local-files/requests"), post(create))
        .layer(DefaultBodyLimit::max(CREATE_BODY_MAX));
    let result = Router::new()
        .route(
            &format!("{base}/local-files/requests/{{request}}/result"),
            post(finish),
        )
        .layer(DefaultBodyLimit::max(RESULT_BODY_MAX));
    Router::new()
        .route(
            &format!("{base}/local-files-grant"),
            get(grant_read).put(grant_issue).delete(grant_revoke),
        )
        .route(&format!("{base}/local-files"), get(overview))
        .route(&format!("{base}/local-files/poll"), post(poll))
        .route(&format!("{base}/local-files/disconnect"), post(disconnect))
        .route(
            &format!("{base}/local-files/requests/{{request}}"),
            get(status),
        )
        .route(
            &format!("{base}/local-files/requests/{{request}}/content"),
            get(content),
        )
        .merge(create)
        .merge(result)
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_local_file_request",
        "Invalid local file request",
    )
}
fn failure(error: ResourceError) -> Error {
    match error {
        ResourceError::Invalid => invalid(),
        ResourceError::Unauthorized => unauthorized(),
        ResourceError::NotFound => Error(StatusCode::NOT_FOUND, "not_found", "Not found"),
        ResourceError::Conflict(code) => {
            let (status, message) = match code {
                "local_files_not_connected" => (
                    StatusCode::CONFLICT,
                    "No folder is connected: the owner has to open this conversation in Chrome and connect a folder",
                ),
                "local_files_no_running_turn" => (
                    StatusCode::CONFLICT,
                    "Only a running turn of this conversation may ask for local files",
                ),
                "local_files_connected_elsewhere" => (
                    StatusCode::CONFLICT,
                    "The folder is connected in another tab",
                ),
                "local_files_rate_limited" => (
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many open or recent local file requests",
                ),
                "local_file_request_conflict" => (
                    StatusCode::CONFLICT,
                    "This request_key was already used for a different request",
                ),
                "local_file_request_finished" => (
                    StatusCode::CONFLICT,
                    "This request is already finished or expired",
                ),
                "local_file_request_not_held" => (
                    StatusCode::CONFLICT,
                    "This tab does not hold that request",
                ),
                "local_files_conversation_unavailable" => (
                    StatusCode::CONFLICT,
                    "That conversation is restricted or archived",
                ),
                _ => (StatusCode::CONFLICT, "Precondition refused"),
            };
            Error(status, code, message)
        }
        ResourceError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Storage unavailable",
        ),
    }
}
fn body<T>(value: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    value.map(|Json(v)| v).map_err(|_| invalid())
}
fn request_id(value: &str) -> Result<Uuid, Error> {
    Uuid::parse_str(value)
        .ok()
        .filter(|id| !id.is_nil() && id.hyphenated().to_string() == value)
        .ok_or_else(invalid)
}
/// Exactly one grant header and no browser or owner credential beside it.
fn grant(headers: &HeaderMap) -> Result<String, Error> {
    let mut grants = headers.get_all(LOCAL_FILES_GRANT_HEADER).iter();
    let value = grants.next().ok_or_else(unauthorized)?;
    if grants.next().is_some()
        || [header::COOKIE, header::AUTHORIZATION, header::ORIGIN]
            .iter()
            .any(|h| headers.contains_key(h))
    {
        return Err(unauthorized());
    }
    Ok(value.to_str().map_err(|_| unauthorized())?.to_owned())
}
/// The tab side is a browser page: a session cookie, never a bearer. The
/// store additionally requires an interactive browser session.
async fn tab(state: &AppState, headers: &HeaderMap) -> Result<(OwnerId, String), Error> {
    if !headers.contains_key(header::COOKIE) {
        return Err(unauthorized());
    }
    owner_credential(state, headers).await
}

async fn grant_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .local_file_grant(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn grant_issue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .issue_local_file_grant(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok((StatusCode::CREATED, Json(value)).into_response())
}
async fn grant_revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .revoke_local_file_grant(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Listing {
    limit: Option<u16>,
}
async fn overview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<Listing>, QueryRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = tab(&state, &headers).await?;
    let Query(listing) = query.map_err(|_| invalid())?;
    let value = state
        .store
        .local_files_overview(
            &credential,
            &owner,
            &conversation(&id)?,
            listing.limit.unwrap_or(20),
        )
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn poll(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<LocalFilePoll>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = tab(&state, &headers).await?;
    let value = state
        .store
        .poll_local_files(&credential, &owner, &conversation(&id)?, &body(request)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}
async fn disconnect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<LocalFileDisconnect>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = tab(&state, &headers).await?;
    state
        .store
        .disconnect_local_files(&credential, &owner, &conversation(&id)?, &body(request)?)
        .await
        .map_err(failure)?;
    Ok(Json(serde_json::json!({"connected": false})).into_response())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Holder {
    connection_id: Uuid,
}
async fn content(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, request)): Path<(String, String)>,
    query: Result<Query<Holder>, QueryRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = tab(&state, &headers).await?;
    let Query(holder) = query.map_err(|_| invalid())?;
    let bytes = state
        .store
        .local_file_content(
            &credential,
            &owner,
            &conversation(&id)?,
            request_id(&request)?,
            holder.connection_id,
        )
        .await
        .map_err(failure)?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
}

/// What the server itself verified about a read or package upload: the
/// owner's completed encrypted upload of this conversation, already
/// prepared as a provider file by `.../attachment`.
async fn upload_facts(
    state: &AppState,
    credential: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
    upload: Uuid,
) -> Result<LocalFileUploadFacts, Error> {
    let not_ready = || {
        Error(
            StatusCode::CONFLICT,
            "local_file_upload_not_ready",
            "Prepare the completed encrypted upload for the assistant first",
        )
    };
    let status = state
        .store
        .encrypted_upload_status(credential, owner, conversation, upload)
        .await
        .map_err(|_| not_ready())?;
    let (receipt, path) =
        crate::encrypted_upload_ingest::prepared_receipt(state, &status).ok_or_else(not_ready)?;
    Ok(LocalFileUploadFacts {
        upload_id: upload,
        filename: status.file.filename.clone(),
        media_type: status.file.media_type.clone(),
        byte_length: status.file.plaintext_size,
        sha256: crate::encrypted_upload_ingest::note_sha256(&receipt.note),
        local_file: path.to_str().map(str::to_owned),
        note: receipt.note,
    })
}
async fn finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, request)): Path<(String, String)>,
    finish: Result<Json<LocalFileFinish>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = tab(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let request = request_id(&request)?;
    let finish = body(finish)?;
    let upload = match finish.upload_id {
        Some(upload) => {
            Some(upload_facts(&state, &credential, &owner, &conversation, upload).await?)
        }
        None => None,
    };
    let value = state
        .store
        .finish_local_file_request(
            &credential,
            &owner,
            &conversation,
            request,
            &finish,
            upload.as_ref(),
        )
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<LocalFileRequestCreate>, JsonRejection>,
) -> Result<Response, Error> {
    let grant = grant(&headers)?;
    let request = body(request)?;
    let content = match request.content_base64.as_deref() {
        Some(text) => Some(crate::message_attachments::decode_base64(text).ok_or_else(invalid)?),
        None => None,
    };
    let receipt = state
        .store
        .create_local_file_request(&grant, &conversation(&id)?, &request, content.as_deref())
        .await
        .map_err(failure)?;
    Ok((
        if receipt.created {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        },
        Json(receipt),
    )
        .into_response())
}
async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Response, Error> {
    let grant = grant(&headers)?;
    let value = state
        .store
        .local_file_request(&grant, &conversation(&id)?, request_id(&request)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

#[cfg(test)]
#[path = "local_files_http_tests.rs"]
mod tests;
