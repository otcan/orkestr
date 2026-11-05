//! Native V2 browser ciphertext transport. Chunk limits apply before body
//! buffering. Kept distinct from legacy base64 uploads and message admission.
use crate::{archived_history_http::owner_credential, AppState};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::attachment_store::AttachmentError;
use uuid::Uuid;

#[cfg(all(test, unix))]
mod tests;

pub(crate) fn router() -> Router<AppState> {
    let control = Router::new()
        .route(
            "/api/v2/conversations/{conversation}/encrypted-uploads",
            post(start),
        )
        .route(
            "/api/v2/conversations/{conversation}/encrypted-uploads/{id}",
            get(status).delete(remove),
        )
        .route(
            "/api/v2/conversations/{conversation}/encrypted-uploads/{id}/complete",
            post(finish),
        )
        .route(
            "/api/v2/conversations/{conversation}/encrypted-uploads/{id}/attachment",
            post(attach),
        )
        .layer(DefaultBodyLimit::max(192 * 1024));
    let chunks = Router::new()
        .route(
            "/api/v2/conversations/{conversation}/encrypted-uploads/{id}/chunks/{index}",
            get(read_chunk).put(put_chunk),
        )
        .layer(DefaultBodyLimit::max(ENCRYPTED_UPLOAD_CIPHERTEXT_MAX));
    control.merge(chunks)
}

fn failed(error: AttachmentError) -> Response {
    use AttachmentError::*;
    let (status, code) = match error {
        Invalid => (StatusCode::BAD_REQUEST, "encrypted_upload_invalid"),
        Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
        NotFound => (StatusCode::NOT_FOUND, "not_found"),
        EncryptionKeyRequired => (StatusCode::CONFLICT, "attachment_encryption_key_required"),
        Conflict | Removed | Inert => (StatusCode::CONFLICT, "encrypted_upload_conflict"),
        Unavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "encrypted_upload_unavailable",
        ),
    };
    (status, Json(serde_json::json!({"error":code}))).into_response()
}

async fn start(
    State(state): State<AppState>,
    Path(conversation): Path<ConversationId>,
    headers: HeaderMap,
    Json(file): Json<EncryptedUploadStart>,
) -> Response {
    let (owner, credential) = match owner_credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match state
        .store
        .encrypted_upload_start_for_ingest(
            &credential,
            &owner,
            &conversation,
            &file,
            state
                .attachment_ingest
                .as_ref()
                .map(|v| v.recipient.as_str()),
        )
        .await
    {
        Ok(v) => Json(v).into_response(),
        Err(e) => failed(e),
    }
}

async fn attach(
    State(state): State<AppState>,
    Path((conversation, id)): Path<(ConversationId, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (owner, credential) = match owner_credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let status = match state
        .store
        .encrypted_upload_status(&credential, &owner, &conversation, id)
        .await
    {
        Ok(v) => v,
        Err(e) => return failed(e),
    };
    match crate::encrypted_upload_ingest::materialize(&state,&credential,&status).await {
        Ok(receipt)=>Json(receipt).into_response(),
        Err(_)=>(StatusCode::CONFLICT,Json(serde_json::json!({"error":"encrypted_attachment_not_ready","message":"Encrypted file could not be verified and prepared for the assistant"}))).into_response(),
    }
}

async fn status(
    State(state): State<AppState>,
    Path((conversation, id)): Path<(ConversationId, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (owner, credential) = match owner_credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match state
        .store
        .encrypted_upload_status(&credential, &owner, &conversation, id)
        .await
    {
        Ok(v) => Json(v).into_response(),
        Err(e) => failed(e),
    }
}

async fn put_chunk(
    State(state): State<AppState>,
    Path((conversation, id, index)): Path<(ConversationId, Uuid, u64)>,
    headers: HeaderMap,
    ciphertext: Bytes,
) -> Response {
    let (owner, credential) = match owner_credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let Some(digest) = headers
        .get("x-orkestr-ciphertext-sha256")
        .and_then(|h| h.to_str().ok())
    else {
        return failed(AttachmentError::Invalid);
    };
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        != Some("application/octet-stream")
    {
        return failed(AttachmentError::Invalid);
    }
    match state
        .store
        .encrypted_upload_put(
            &credential,
            &owner,
            &conversation,
            id,
            index,
            digest,
            &ciphertext,
        )
        .await
    {
        Ok(v) => Json(v).into_response(),
        Err(e) => failed(e),
    }
}

async fn finish(
    State(state): State<AppState>,
    Path((conversation, id)): Path<(ConversationId, Uuid)>,
    headers: HeaderMap,
    Json(chunks): Json<Vec<EncryptedUploadChunk>>,
) -> Response {
    let (owner, credential) = match owner_credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match state
        .store
        .encrypted_upload_finish(&credential, &owner, &conversation, id, &chunks)
        .await
    {
        Ok(v) => Json(v).into_response(),
        Err(e) => failed(e),
    }
}

async fn read_chunk(
    State(state): State<AppState>,
    Path((conversation, id, index)): Path<(ConversationId, Uuid, u64)>,
    headers: HeaderMap,
) -> Response {
    let (owner, credential) = match owner_credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match state
        .store
        .encrypted_upload_chunk(&credential, &owner, &conversation, id, index)
        .await
    {
        Ok(v) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CACHE_CONTROL, "no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            v,
        )
            .into_response(),
        Err(e) => failed(e),
    }
}

async fn remove(
    State(state): State<AppState>,
    Path((conversation, id)): Path<(ConversationId, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (owner, credential) = match owner_credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let _lifecycle = match state.attachment_ingest.as_ref() {
        Some(ingest) => Some(ingest.lifecycle.write().await),
        None => None,
    };
    let status = match state
        .store
        .encrypted_upload_status(&credential, &owner, &conversation, id)
        .await
    {
        Ok(v) => v,
        Err(e) => return failed(e),
    };
    if crate::encrypted_upload_ingest::remove_export(&state, &status).is_err() {
        return failed(AttachmentError::Unavailable);
    }
    match state
        .store
        .encrypted_upload_remove(&credential, &owner, &conversation, id)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => failed(e),
    }
}
