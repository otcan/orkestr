//! Files a running Deep turn attaches to its own reply (ORK-779; the agent's
//! tool is `v2/tools/reply_attach.py`, the WhatsApp side
//! `v2/compat/v1_runtime/reply_files.py`).
//!
//! Grant holder (header `x-orkestr-agent-timer-grant`, the conversation's
//! agent grant; machine requests only, never with a cookie, bearer or
//! Origin), only while the conversation has a running Deep turn:
//! - `POST /api/v2/conversations/{id}/agent-attachments`: store up to 8 files
//!   (16 MiB in all; any type the store takes, never a hidden or secret-looking
//!   file) in this conversation's attachment store, like an owner upload. 201 with one
//!   marker line per file for the reply, 200 for a replay of the same
//!   request key. A plaintext copy goes to the attachment export directory,
//!   where the WhatsApp adapter reads the bytes it sends.
//!
//! Owner (browser cookie or machine bearer):
//! - `GET /api/v2/conversations/{id}/agent-attachments/{manifest}`: the
//!   manifest of an agent attachment of this conversation; any other manifest
//!   is not found. The adapter checks it before it sends a file.
//!
//! The conversation is the grant's: an upload never names another one, and a
//! marker never carries a path.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::conversation;
use crate::message_attachments::{decode_base64, derived, export};
use axum::extract::{rejection::JsonRejection, DefaultBodyLimit, Path};
use orkestr_v2_store_sqlite::{attachment_store::AttachmentError, ResourceError};
use sha2::{Digest, Sha256};

/// Base64 of 16 MiB plus JSON framing.
const BODY_MAX: usize = 24 * 1024 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/conversations/{id}/agent-attachments", post(upload))
        .route(
            "/api/v2/conversations/{id}/agent-attachments/{manifest}",
            get(manifest),
        )
        .layer(DefaultBodyLimit::max(BODY_MAX))
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_agent_attachment",
        "Invalid attachment upload",
    )
}
fn refused_type() -> Error {
    Error(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "agent_attachment_type_mismatch",
        "A file's type must match its extension (a .pdf is application/pdf)",
    )
}
fn refused_name() -> Error {
    Error(
        StatusCode::UNPROCESSABLE_ENTITY,
        "agent_attachment_name_refused",
        "Hidden or secret-looking files (keys, credentials) cannot be attached",
    )
}
fn too_large() -> Error {
    Error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "agent_attachment_too_large",
        "Attachments are limited to 16 MiB per reply",
    )
}
fn failure(error: ResourceError) -> Error {
    match error {
        ResourceError::Invalid => invalid(),
        ResourceError::Unauthorized => unauthorized(),
        ResourceError::NotFound => Error(StatusCode::NOT_FOUND, "not_found", "Not found"),
        ResourceError::Conflict(code) => {
            let message = match code {
                "agent_attachment_no_running_turn" => {
                    "Only a running Deep turn of this conversation may attach files"
                }
                "agent_attachment_conversation_unavailable" => {
                    "This conversation is restricted or archived"
                }
                "attachment_encryption_key_required" => {
                    "Attachments are stored encrypted for the owner's browser keys, and none is enrolled; ask the owner to open the app in a browser"
                }
                "agent_attachment_conflict" => {
                    "This request_key was already used for different files"
                }
                _ => "Precondition refused",
            };
            Error(StatusCode::CONFLICT, code, message)
        }
        ResourceError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Storage unavailable",
        ),
    }
}

async fn upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<MessageAttachmentUpload>, JsonRejection>,
) -> Result<Response, Error> {
    let grant = crate::agent_timers_http::grant(&headers)?;
    let conversation = conversation(&id)?;
    let Json(upload) = body.map_err(|_| invalid())?;
    if !upload.is_valid() {
        return Err(invalid());
    }
    let mut contents = Vec::with_capacity(upload.files.len());
    let mut total = 0usize;
    for file in &upload.files {
        if !agent_attachment_name_allowed(&file.filename) {
            return Err(refused_name());
        }
        if !agent_attachment_type_consistent(&file.filename, &file.media_type) {
            return Err(refused_type());
        }
        let bytes = decode_base64(&file.content_base64)
            .filter(|bytes| !bytes.is_empty())
            .ok_or_else(invalid)?;
        total += bytes.len();
        if total > AGENT_ATTACHMENT_BYTES_MAX {
            return Err(too_large());
        }
        contents.push(bytes);
    }
    let owner = state
        .store
        .agent_attachment_owner(&grant, &conversation)
        .await
        .map_err(failure)?;
    let request = import_request(&owner, &conversation, &upload, &contents);
    let (receipt, replayed) = state
        .store
        .import_agent_attachments(&grant, &conversation, &request)
        .await
        .map_err(failure)?;
    let manifest = receipt.manifest;
    if let Some(dir) = state.attachment_export.as_ref() {
        // The copy the WhatsApp adapter sends; content-addressed, so a replay
        // writes nothing new. Without it the reply could not carry the file.
        for (reference, bytes) in manifest.references.iter().zip(&contents) {
            let path = export(
                dir,
                &conversation,
                &reference.sha256,
                &reference.media_type,
                &reference.filename,
                bytes,
            );
            if path.is_none() {
                return Err(Error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "agent_attachment_export_failed",
                    "The file was stored but its delivery copy could not be written; retry with the same request key",
                ));
            }
        }
    }
    let note = manifest
        .references
        .iter()
        .map(|r| agent_attachment_marker(manifest.manifest_id, r.reference_id, &r.filename))
        .collect::<Vec<_>>()
        .join("\n");
    let receipt = MessageAttachmentReceipt {
        manifest_id: Some(manifest.manifest_id),
        attachments: manifest
            .references
            .iter()
            .map(|r| MessageAttachmentSummary {
                attachment_id: r.reference_id.to_string(),
                filename: r.filename.clone(),
                media_type: r.media_type.clone(),
                byte_length: r.byte_length,
            })
            .collect(),
        note,
    };
    let status = if replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(receipt)).into_response())
}

/// The import of one upload, with IDs derived from the conversation and the
/// request key, so a replay names the same manifest and references.
fn import_request(
    owner: &OwnerId,
    conversation: &ConversationId,
    upload: &MessageAttachmentUpload,
    contents: &[Vec<u8>],
) -> AttachmentImportRequest {
    let key = format!("agent:{conversation}:{}", upload.request_key);
    let reference = |file: &MessageAttachmentFile, bytes: &[u8], id: Uuid| AttachmentReference {
        reference_id: id,
        message_id: None,
        filename: file.filename.clone(),
        media_type: file.media_type.clone(),
        byte_length: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        state: AttachmentState::Available,
    };
    let source: Vec<AttachmentReference> = upload
        .files
        .iter()
        .zip(contents)
        .enumerate()
        .map(|(i, (f, b))| reference(f, b, derived(&key, &format!("source-{i}"))))
        .collect();
    let target: Vec<AttachmentReference> = source
        .iter()
        .enumerate()
        .map(|(i, r)| AttachmentReference {
            reference_id: derived(&key, &format!("target-{i}")),
            ..r.clone()
        })
        .collect();
    AttachmentImportRequest {
        request_key: format!("{AGENT_ATTACHMENT_REQUEST_PREFIX}{}", upload.request_key),
        source: AttachmentBundle {
            manifest: AttachmentManifest {
                schema_version: 1,
                manifest_id: derived(&key, "source-manifest"),
                owner_id: owner.clone(),
                conversation_id: ConversationId(derived(&key, "source-conversation")),
                references: source.clone(),
            },
            contents: source
                .iter()
                .zip(contents)
                .map(|(r, b)| AttachmentContent {
                    reference_id: r.reference_id,
                    bytes: b.clone(),
                })
                .collect(),
        },
        target_manifest: AttachmentManifest {
            schema_version: 1,
            manifest_id: derived(&key, "target-manifest"),
            owner_id: owner.clone(),
            conversation_id: conversation.clone(),
            references: target.clone(),
        },
        mapping: source
            .iter()
            .zip(&target)
            .map(|(a, b)| AttachmentReferenceMapping {
                source_reference_id: a.reference_id,
                target_reference_id: b.reference_id,
            })
            .collect(),
    }
}

async fn manifest(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, manifest)): Path<(String, String)>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let manifest = Uuid::parse_str(&manifest)
        .ok()
        .filter(|m| !m.is_nil() && m.hyphenated().to_string() == manifest)
        .ok_or_else(invalid)?;
    let value = state
        .store
        .agent_attachment_manifest_authenticated(&credential, &owner, &conversation, manifest)
        .await
        .map_err(|error| match error {
            AttachmentError::Unauthorized => unauthorized(),
            AttachmentError::Invalid => invalid(),
            AttachmentError::NotFound | AttachmentError::Removed | AttachmentError::Inert => {
                Error(StatusCode::NOT_FOUND, "not_found", "Not found")
            }
            _ => Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "attachment_unavailable",
                "Attachment store unavailable",
            ),
        })?;
    Ok(Json(value).into_response())
}

#[cfg(test)]
#[path = "agent_attachments_http_tests.rs"]
mod tests;
