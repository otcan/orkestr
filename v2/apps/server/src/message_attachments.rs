//! Attach and Paste text from the web UI.
//!
//! Native conversation: the files are stored in the conversation attachment
//! store (idempotent per request key) and written as local files the provider
//! can open, `<dir>/<conversation>/<sha256><ext>`, like the WhatsApp adapter
//! does. The receipt carries a note naming each file and its local path; the
//! UI appends it to the message, so the model sees the file. Nothing here
//! admits input.
//!
//! Linked V1 chat: the files are uploaded to V1 (`POST /api/threads/:id/uploads`,
//! as the V1 web UI does) and kept here for an hour under an upload id; the
//! owner input then names those ids and V1 attaches the files to the message.
use super::*;
use crate::archived_history_http::owner_credential;
use axum::extract::{rejection::JsonRejection, DefaultBodyLimit, Path};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, time::Instant};

/// Base64 of 16 MiB plus JSON framing.
const BODY_MAX: usize = 24 * 1024 * 1024;
const V1_UPLOAD_TTL: Duration = Duration::from_secs(3600);
const V1_UPLOADS_MAX: usize = 256;

/// Environment keys for the local copies the provider opens.
pub const EXPORT_DIR_ENV: &str = "ORKESTR_V2_ATTACHMENT_EXPORT_DIR";
pub const EXPORT_GROUP_ENV: &str = "ORKESTR_V2_ATTACHMENT_EXPORT_GROUP";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v2/conversations/{id}/message-attachments",
            post(native_upload),
        )
        .route("/api/v2/v1-threads/{thread}/uploads", post(v1_upload))
        .layer(DefaultBodyLimit::max(BODY_MAX))
}

/// Where local copies go: the operator directory, else `<home>/message-attachments`.
#[derive(Clone, Debug)]
pub struct ExportDir {
    pub dir: PathBuf,
    pub gid: Option<u32>,
}
impl ExportDir {
    pub fn from_env(home: &std::path::Path) -> Self {
        let dir = std::env::var_os(EXPORT_DIR_ENV)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join("message-attachments"));
        let gid = std::env::var(EXPORT_GROUP_ENV)
            .ok()
            .and_then(|name| group_id(&name));
        Self { dir, gid }
    }
}
fn group_id(name: &str) -> Option<u32> {
    let groups = std::fs::read_to_string("/etc/group").ok()?;
    groups.lines().find_map(|line| {
        let mut parts = line.split(':');
        (parts.next()? == name).then(|| parts.nth(1)?.parse().ok())?
    })
}

/// Uploaded V1 attachment descriptors, per thread, by upload id.
/// Upload id -> (uploaded at, V1 thread, V1 attachment descriptor).
type UploadMap = HashMap<String, (Instant, String, Value)>;
#[derive(Clone, Default)]
pub(crate) struct V1Uploads(Arc<Mutex<UploadMap>>);
impl V1Uploads {
    async fn put(&self, thread: &str, id: String, value: Value) {
        let mut map = self.0.lock().await;
        map.retain(|_, (at, _, _)| at.elapsed() < V1_UPLOAD_TTL);
        if map.len() >= V1_UPLOADS_MAX {
            if let Some(oldest) = map
                .iter()
                .min_by_key(|(_, (at, _, _))| *at)
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest);
            }
        }
        map.insert(id, (Instant::now(), thread.to_owned(), value));
    }
    /// Descriptors for `ids` of `thread`, or `None` if any is unknown or expired.
    pub(crate) async fn resolve(&self, thread: &str, ids: &[String]) -> Option<Vec<Value>> {
        let map = self.0.lock().await;
        ids.iter()
            .map(|id| {
                map.get(id)
                    .filter(|(at, t, _)| t == thread && at.elapsed() < V1_UPLOAD_TTL)
                    .map(|(_, _, v)| v.clone())
            })
            .collect()
    }
}

pub(crate) fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    };
    let clean: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let trimmed: &[u8] = {
        let mut end = clean.len();
        while end > 0 && clean[end - 1] == b'=' {
            end -= 1;
        }
        if clean.len() - end > 2 {
            return None;
        }
        &clean[..end]
    };
    if trimmed.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(trimmed.len() * 3 / 4);
    for chunk in trimmed.chunks(4) {
        let mut acc = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            acc |= value(*c)? << (18 - 6 * i);
        }
        let bytes = acc.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

/// Deterministic UUID (v4 layout) from a request key and a label, so a
/// replayed upload names the same manifest and references.
fn derived(key: &str, label: &str) -> Uuid {
    let digest = Sha256::digest(format!("orkestr-v2-message-attachment\0{key}\0{label}"));
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_random_bytes(bytes).into_uuid()
}

fn extension(media_type: &str, filename: &str) -> String {
    match media_type {
        "image/jpeg" => ".jpg".into(),
        "image/png" => ".png".into(),
        "image/gif" => ".gif".into(),
        "image/webp" => ".webp".into(),
        "application/pdf" => ".pdf".into(),
        "text/plain" => ".txt".into(),
        _ => std::path::Path::new(filename)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| {
                let e: String = e
                    .chars()
                    .filter(char::is_ascii_alphanumeric)
                    .take(8)
                    .collect::<String>()
                    .to_lowercase();
                if e.is_empty() {
                    String::new()
                } else {
                    format!(".{e}")
                }
            })
            .unwrap_or_default(),
    }
}

/// Writes `<dir>/<conversation>/<sha256><ext>` once (content-addressed), group
/// readable when a group is configured. Returns the path, or `None` on failure.
pub(crate) fn export(
    target: &ExportDir,
    conversation: &ConversationId,
    sha256: &str,
    media_type: &str,
    filename: &str,
    bytes: &[u8],
) -> Option<PathBuf> {
    use std::os::unix::fs::{chown, OpenOptionsExt, PermissionsExt};
    let folder = target.dir.join(conversation.to_string());
    std::fs::create_dir_all(&folder).ok()?;
    let mode = |path: &std::path::Path, bits| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(bits))
    };
    mode(&folder, 0o750).ok()?;
    if let Some(gid) = target.gid {
        chown(&target.dir, None, Some(gid)).ok()?;
        chown(&folder, None, Some(gid)).ok()?;
    }
    let path = folder.join(format!("{sha256}{}", extension(media_type, filename)));
    if !path.exists() {
        let temporary = folder.join(format!(".{sha256}.{}.tmp", Uuid::new_v4().simple()));
        let write = || -> std::io::Result<()> {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o640)
                .custom_flags(0o400_000) // O_NOFOLLOW
                .open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            if let Some(gid) = target.gid {
                chown(&temporary, None, Some(gid))?;
            }
            std::fs::rename(&temporary, &path)
        };
        if write().is_err() {
            let _ = std::fs::remove_file(&temporary);
            return None;
        }
    }
    Some(path)
}

/// The text the model reads, in the WhatsApp adapter's format.
pub(crate) fn note(
    manifest: &Uuid,
    files: &[(MessageAttachmentSummary, Option<PathBuf>)],
) -> String {
    let mut lines = vec![format!(
        "[Files attached in the Orkestr app, stored in this conversation's attachment store, manifest {manifest}:"
    )];
    for (file, path) in files {
        let mut line = format!(
            "- {} ({}, {} bytes, reference {}",
            file.filename, file.media_type, file.byte_length, file.attachment_id
        );
        if let Some(path) = path {
            line.push_str(&format!(", local file {}", path.display()));
        }
        line.push(')');
        lines.push(line);
    }
    if files.iter().any(|(_, p)| p.is_some()) {
        lines.push(
            "Open the local file to see an attachment (for an image use your image viewing tool)."
                .into(),
        );
    }
    lines.join("\n") + "]"
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_attachment",
        "Invalid attachment upload",
    )
}
fn too_large() -> Error {
    Error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "attachment_too_large",
        "Attachments are limited to 16 MiB per message",
    )
}

fn decoded(upload: &MessageAttachmentUpload) -> Result<Vec<Vec<u8>>, Error> {
    if !upload.is_valid() {
        return Err(invalid());
    }
    let mut total = 0usize;
    let mut out = Vec::with_capacity(upload.files.len());
    for file in &upload.files {
        let bytes = decode_base64(&file.content_base64).ok_or_else(invalid)?;
        if bytes.is_empty() {
            return Err(invalid());
        }
        total += bytes.len();
        if total > MESSAGE_ATTACHMENT_BYTES_MAX {
            return Err(too_large());
        }
        out.push(bytes);
    }
    Ok(out)
}

pub(crate) async fn native_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<MessageAttachmentUpload>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = Uuid::parse_str(&id)
        .ok()
        .filter(|id| !id.is_nil())
        .map(ConversationId)
        .ok_or_else(invalid)?;
    let Json(upload) = body.map_err(|_| invalid())?;
    let contents = decoded(&upload)?;
    let key = &upload.request_key;
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
        .zip(&contents)
        .enumerate()
        .map(|(i, (f, b))| reference(f, b, derived(key, &format!("source-{i}"))))
        .collect();
    let target: Vec<AttachmentReference> = source
        .iter()
        .enumerate()
        .map(|(i, r)| AttachmentReference {
            reference_id: derived(key, &format!("target-{i}")),
            ..r.clone()
        })
        .collect();
    let manifest_id = derived(key, "target-manifest");
    let request = AttachmentImportRequest {
        request_key: format!("ui-attach-{key}"),
        source: AttachmentBundle {
            manifest: AttachmentManifest {
                schema_version: 1,
                manifest_id: derived(key, "source-manifest"),
                owner_id: owner.clone(),
                conversation_id: ConversationId(derived(key, "source-conversation")),
                references: source.clone(),
            },
            contents: source
                .iter()
                .zip(&contents)
                .map(|(r, b)| AttachmentContent {
                    reference_id: r.reference_id,
                    bytes: b.clone(),
                })
                .collect(),
        },
        target_manifest: AttachmentManifest {
            schema_version: 1,
            manifest_id,
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
    };
    state
        .store
        .import_attachment_bundle_authenticated(&credential, &owner, &conversation, &request)
        .await
        .map_err(|error| {
            use orkestr_v2_store_sqlite::attachment_store::AttachmentError as E;
            match error {
                E::Unauthorized => unauthorized(),
                E::NotFound => Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found"),
                E::Invalid => invalid(),
                E::Conflict | E::Removed => Error(
                    StatusCode::CONFLICT,
                    "attachment_conflict",
                    "This upload key was used for different files",
                ),
                _ => Error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "attachment_unavailable",
                    "Attachment store unavailable",
                ),
            }
        })?;
    let export_dir = state.attachment_export.clone();
    let files: Vec<(MessageAttachmentSummary, Option<PathBuf>)> = target
        .iter()
        .zip(contents)
        .map(|(r, bytes)| {
            let path = export_dir.as_ref().and_then(|dir| {
                export(
                    dir,
                    &conversation,
                    &r.sha256,
                    &r.media_type,
                    &r.filename,
                    &bytes,
                )
            });
            (
                MessageAttachmentSummary {
                    attachment_id: r.reference_id.to_string(),
                    filename: r.filename.clone(),
                    media_type: r.media_type.clone(),
                    byte_length: r.byte_length,
                },
                path,
            )
        })
        .collect();
    let receipt = MessageAttachmentReceipt {
        manifest_id: Some(manifest_id),
        note: note(&manifest_id, &files),
        attachments: files.into_iter().map(|(f, _)| f).collect(),
    };
    Ok(Json(receipt).into_response())
}

pub(crate) async fn v1_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
    body: Result<Json<MessageAttachmentUpload>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Json(upload) = body.map_err(|_| invalid())?;
    if !valid_v1_thread_id(&thread) {
        return Err(invalid());
    }
    let contents = decoded(&upload)?;
    let (broker, record) =
        crate::sidebar_http::listed_thread(&state, &owner, &credential, &thread).await?;
    if record.delegated {
        return Err(Error(
            StatusCode::CONFLICT,
            "v1_thread_delegated",
            "This chat runs on V2; attach files in its V2 conversation",
        ));
    }
    let files: Vec<Value> = upload
        .files
        .iter()
        .map(|f| json!({"name": f.filename, "type": f.media_type, "contentBase64": f.content_base64}))
        .collect();
    let path = format!("/api/threads/{}/uploads", record.id);
    let (status, value) = broker
        .write("POST", &path, json!({ "files": files }), 4 * 1024 * 1024)
        .await
        .map_err(|_| {
            Error(
                StatusCode::GATEWAY_TIMEOUT,
                "v1_upload_unknown",
                "V1 did not confirm the upload; try again",
            )
        })?;
    let attachments = match status {
        200..=299 => value
            .get("attachments")
            .and_then(Value::as_array)
            .cloned()
            .filter(|a| a.len() == contents.len())
            .ok_or(Error(
                StatusCode::BAD_GATEWAY,
                "v1_upload_unverified",
                "V1 upload reply could not be verified",
            ))?,
        413 => return Err(too_large()),
        _ => {
            return Err(Error(
                StatusCode::BAD_GATEWAY,
                "v1_upload_refused",
                "V1 refused the upload",
            ))
        }
    };
    let mut summaries = Vec::with_capacity(attachments.len());
    for (i, (attachment, bytes)) in attachments.into_iter().zip(&contents).enumerate() {
        let id = derived(&upload.request_key, &format!("v1-{}-{i}", record.id)).to_string();
        let file = &upload.files[i];
        state
            .v1_uploads
            .put(&record.id, id.clone(), attachment)
            .await;
        summaries.push(MessageAttachmentSummary {
            attachment_id: id,
            filename: file.filename.clone(),
            media_type: file.media_type.clone(),
            byte_length: bytes.len() as u64,
        });
    }
    Ok(Json(MessageAttachmentReceipt {
        manifest_id: None,
        attachments: summaries,
        note: String::new(),
    })
    .into_response())
}

#[cfg(test)]
#[path = "message_attachments_tests.rs"]
mod tests;
