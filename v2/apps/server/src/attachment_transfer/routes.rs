//! Coordinator mounts this router inside the existing browser guard.
use super::{authority, download};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::attachment_store::AttachmentError;
use serde::Deserialize;
use uuid::Uuid;

pub(crate) fn router() -> Router<crate::AppState> {
    Router::new()
        .route(
            "/conversations/{conversation}/attachment-manifests",
            get(super::list::get),
        )
        .route(
            "/conversations/{conversation}/attachment-imports",
            post(import),
        )
        .route(
            "/conversations/{conversation}/attachment-manifests/{manifest}",
            get(manifest),
        )
        .route(
            "/conversations/{conversation}/attachment-manifests/{manifest}/export",
            get(export),
        )
        .route(
            "/conversations/{conversation}/attachments/{manifest}/{reference}",
            get(bytes).delete(remove),
        )
        .layer(DefaultBodyLimit::max(ATTACHMENT_MAX_JSON_BYTES))
}
pub(super) fn failure(error: AttachmentError) -> Response {
    use AttachmentError::*;
    let status = match error {
        Invalid => StatusCode::BAD_REQUEST,
        Unauthorized => StatusCode::UNAUTHORIZED,
        NotFound => StatusCode::NOT_FOUND,
        Removed => StatusCode::GONE,
        Inert | Conflict => StatusCode::CONFLICT,
        Unavailable => StatusCode::SERVICE_UNAVAILABLE,
    };
    (
        status,
        Json(serde_json::json!({"error":"attachment request refused"})),
    )
        .into_response()
}
async fn import(
    State(state): State<crate::AppState>,
    Path(conversation): Path<ConversationId>,
    headers: HeaderMap,
    Json(request): Json<AttachmentImportRequest>,
) -> Response {
    let (owner, credential) = match authority::credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match state
        .store
        .import_attachment_bundle_authenticated(&credential, &owner, &conversation, &request)
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(e) => failure(e),
    }
}
async fn manifest(
    State(state): State<crate::AppState>,
    Path((conversation, manifest)): Path<(ConversationId, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (owner, credential) = match authority::credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match state
        .store
        .attachment_manifest_authenticated(&credential, &owner, &conversation, manifest)
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(e) => failure(e),
    }
}
async fn export(
    State(state): State<crate::AppState>,
    Path((conversation, manifest)): Path<(ConversationId, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (owner, credential) = match authority::credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match state
        .store
        .export_attachment_bundle_authenticated(&credential, &owner, &conversation, manifest)
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(e) => failure(e),
    }
}
async fn bytes(
    State(state): State<crate::AppState>,
    Path((conversation, manifest, reference)): Path<(ConversationId, Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (owner, credential) = match authority::credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match state
        .store
        .download_attachment_authenticated(&credential, &owner, &conversation, manifest, reference)
        .await
    {
        Ok((reference, bytes)) => download::response(&reference, bytes)
            .unwrap_or_else(|_| failure(AttachmentError::Unavailable)),
        Err(e) => failure(e),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Removal {
    request_key: String,
}
async fn remove(
    State(state): State<crate::AppState>,
    Path((conversation, manifest, reference)): Path<(ConversationId, Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<Removal>,
) -> Response {
    let (owner, credential) = match authority::credential(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match state
        .store
        .remove_attachment_authenticated(
            &credential,
            &owner,
            &conversation,
            manifest,
            reference,
            &request.request_key,
        )
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(e) => failure(e),
    }
}
