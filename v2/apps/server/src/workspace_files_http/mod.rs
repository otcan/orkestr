//! The Files panel's file browser (`docs/v2/workspace-files.md`): a read-only
//! view of the folder a conversation's Deep session works in.
//!
//! Core is the web-facing process and never opens that folder. The reader
//! (`reader::Reader`; on a host the workspace reader socket) resolves the
//! folder from the operator's runtime plan and enforces confinement and
//! protected names. Core checks the path first (relative, no `.`/`..`, no
//! protected part), drops any protected name a reader still reports, and
//! serves files with fixed safe headers. Every route needs the owner's
//! password-signed-in browser session; there is no write route.
use super::*;
use axum::extract::{rejection::QueryRejection, Path, Query};
use orkestr_v2_store_sqlite::ResourceError;

pub(crate) mod reader;
#[cfg(test)]
mod tests;

use reader::{ReaderError, Request};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/conversations/{id}/workspace", get(list))
        .route("/api/v2/conversations/{id}/workspace/preview", get(preview))
        .route("/api/v2/conversations/{id}/workspace/file", get(file))
}

impl AppState {
    /// Trusted startup only: the workspace reader socket named by
    /// `ORKESTR_V2_WORKSPACE_READER_SOCKET`, else the default path. Without a
    /// socket there the panel says the folder cannot be shown on this host.
    pub fn with_workspace_reader_from_env(mut self) -> Self {
        self.workspace_reader = Some(Arc::new(reader::SocketReader::from_env()));
        self
    }
    #[cfg(test)]
    pub(crate) fn with_workspace_reader(mut self, reader: Arc<dyn reader::Reader>) -> Self {
        self.workspace_reader = Some(reader);
        self
    }
}

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FileQuery {
    #[serde(default)]
    path: String,
    /// Show an image in the page instead of downloading the file.
    #[serde(default)]
    inline: bool,
}

fn refused(status: StatusCode, code: &'static str, message: &'static str) -> Error {
    Error(status, code, message)
}

fn path_error(error: WorkspacePathError) -> Error {
    match error {
        WorkspacePathError::Protected => refused(
            StatusCode::FORBIDDEN,
            "workspace_protected",
            "This file is protected and is never shown",
        ),
        WorkspacePathError::Absolute | WorkspacePathError::Traversal => refused(
            StatusCode::BAD_REQUEST,
            "workspace_path_outside",
            "The path must stay inside the folder",
        ),
        WorkspacePathError::Invalid => refused(
            StatusCode::BAD_REQUEST,
            "workspace_path_invalid",
            "Invalid path",
        ),
    }
}

fn unavailable() -> Error {
    refused(
        StatusCode::SERVICE_UNAVAILABLE,
        "workspace_unavailable",
        "The chat's folder cannot be read right now",
    )
}

/// The HTTP refusal for a reader error (listing states are handled apart).
fn reader_error(error: ReaderError) -> Error {
    let code = match error {
        ReaderError::NotConfigured => {
            return refused(
                StatusCode::SERVICE_UNAVAILABLE,
                "workspace_not_configured",
                "This host cannot show the chat's folder",
            )
        }
        ReaderError::Unavailable => return unavailable(),
        ReaderError::Refused(code, _) => code,
    };
    match code.as_str() {
        "traversal" | "absolute_path" | "outside_root" => refused(
            StatusCode::FORBIDDEN,
            "workspace_path_outside",
            "The path leads outside the folder",
        ),
        "protected" => path_error(WorkspacePathError::Protected),
        "invalid_path" => path_error(WorkspacePathError::Invalid),
        "not_found" | "root_missing" => refused(
            StatusCode::NOT_FOUND,
            "workspace_not_found",
            "No such file or folder",
        ),
        "not_a_directory" => refused(
            StatusCode::CONFLICT,
            "workspace_not_a_folder",
            "This is not a folder",
        ),
        "not_a_file" => refused(
            StatusCode::CONFLICT,
            "workspace_not_a_file",
            "This is not a file",
        ),
        "too_large" => refused(
            StatusCode::PAYLOAD_TOO_LARGE,
            "workspace_file_too_large",
            "This file is too large to download here",
        ),
        "changed" => refused(
            StatusCode::CONFLICT,
            "workspace_changed",
            "The folder changed while it was read; try again",
        ),
        _ => unavailable(),
    }
}

/// Owner, password session and the conversation's provider; the path checked.
async fn scope(
    state: &AppState,
    headers: &HeaderMap,
    id: &str,
    path: String,
) -> Result<Request, Error> {
    let owner = browser::owner(state, headers).await?;
    let credential = browser::password_session(state, headers).await?;
    let conversation = crate::conversation_resources_http::conversation(id)?;
    workspace_path_parts(&path).map_err(path_error)?;
    let settings = state
        .store
        .conversation_settings(&credential, &owner, &conversation)
        .await
        .map_err(|error| match error {
            ResourceError::NotFound => {
                refused(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
            }
            error => crate::conversation_resources_http::failure(error),
        })?;
    Ok(Request {
        conversation,
        provider: settings.provider,
        path,
    })
}

fn listing(request: &Request, state: WorkspaceState) -> WorkspaceListing {
    WorkspaceListing {
        conversation_id: request.conversation.clone(),
        state,
        root_kind: None,
        root_name: None,
        path: request.path.clone(),
        entries: Vec::new(),
        hidden: 0,
        truncated: false,
    }
}

fn no_store(response: impl IntoResponse) -> Response {
    let mut response = response.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
}

/// `GET .../workspace?path=`: one folder, folders first, newest first.
async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<FileQuery>, QueryRejection>,
) -> Result<Response, Error> {
    let Query(query) = query.map_err(|_| path_error(WorkspacePathError::Invalid))?;
    if query.inline {
        return Err(path_error(WorkspacePathError::Invalid));
    }
    let request = scope(&state, &headers, &id, query.path).await?;
    let Some(reader) = state.workspace_reader.clone() else {
        return Ok(no_store(Json(listing(
            &request,
            WorkspaceState::NotConfigured,
        ))));
    };
    let found = match reader.list(&request).await {
        Ok(found) => found,
        Err(ReaderError::NotConfigured) => {
            return Ok(no_store(Json(listing(
                &request,
                WorkspaceState::NotConfigured,
            ))))
        }
        Err(ReaderError::Refused(code, _)) if code == "root_missing" => {
            return Ok(no_store(Json(listing(&request, WorkspaceState::Missing))))
        }
        Err(ReaderError::Refused(code, _))
            if matches!(
                code.as_str(),
                "root_unreadable" | "root_unavailable" | "plan_invalid"
            ) =>
        {
            return Ok(no_store(Json(listing(
                &request,
                WorkspaceState::Unavailable,
            ))))
        }
        Err(ReaderError::Unavailable) => {
            return Ok(no_store(Json(listing(
                &request,
                WorkspaceState::Unavailable,
            ))))
        }
        Err(error) => return Err(reader_error(error)),
    };
    // Defense in depth: a name the reader should have hidden is hidden here.
    let mut hidden = found.hidden;
    let mut entries = Vec::with_capacity(found.entries.len());
    for entry in found.entries {
        if entry.is_valid() {
            entries.push(entry);
        } else {
            hidden = hidden.saturating_add(1);
        }
    }
    let mut result = listing(&request, WorkspaceState::Ready);
    result.root_kind = Some(found.root_kind);
    result.root_name = Some(found.root_name);
    result.entries = entries;
    result.hidden = hidden;
    result.truncated = found.truncated;
    if !result.is_valid() {
        return Err(unavailable());
    }
    Ok(no_store(Json(result)))
}

fn file_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_owned()
}

/// `GET .../workspace/preview?path=`: text (first 512 KiB), image or neither.
async fn preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<FileQuery>, QueryRejection>,
) -> Result<Response, Error> {
    let Query(query) = query.map_err(|_| path_error(WorkspacePathError::Invalid))?;
    if query.inline || query.path.is_empty() {
        return Err(path_error(WorkspacePathError::Invalid));
    }
    let request = scope(&state, &headers, &id, query.path).await?;
    let reader = state
        .workspace_reader
        .clone()
        .ok_or_else(|| reader_error(ReaderError::NotConfigured))?;
    let read = reader
        .read(&request, WORKSPACE_TEXT_PREVIEW_MAX, true)
        .await
        .map_err(reader_error)?;
    let bytes = axum::body::to_bytes(read.body, WORKSPACE_TEXT_PREVIEW_MAX as usize)
        .await
        .map_err(|_| unavailable())?;
    if bytes.len() as u64 != read.length {
        return Err(unavailable());
    }
    let name = file_name(&request.path);
    let truncated = read.length < read.size;
    let shown = match workspace_image_type(&name) {
        Some(_) if read.size > WORKSPACE_IMAGE_PREVIEW_MAX => WorkspacePreview::TooLarge,
        Some(media_type) => WorkspacePreview::Image {
            media_type: media_type.into(),
        },
        None => match workspace_text(&bytes, truncated) {
            Some(text) => WorkspacePreview::Text { text, truncated },
            None => WorkspacePreview::Binary,
        },
    };
    Ok(no_store(Json(WorkspaceFilePreview {
        conversation_id: request.conversation.clone(),
        path: request.path.clone(),
        name,
        size: read.size,
        modified_ms: read.modified_ms,
        downloadable: read.size <= WORKSPACE_DOWNLOAD_MAX,
        preview: shown,
    })))
}

/// RFC 8187 `filename*` value: every byte outside unreserved characters encoded.
fn disposition(kind: &str, name: &str) -> String {
    use std::fmt::Write;
    let mut encoded = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    format!("{kind}; filename=\"download\"; filename*=UTF-8''{encoded}")
}

/// `GET .../workspace/file?path=[&inline=true]`: the file's bytes. Inline only
/// for a previewable image; everything else is an attachment download.
async fn file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<FileQuery>, QueryRejection>,
) -> Result<Response, Error> {
    let Query(query) = query.map_err(|_| path_error(WorkspacePathError::Invalid))?;
    if query.path.is_empty() {
        return Err(path_error(WorkspacePathError::Invalid));
    }
    let inline = query.inline;
    let request = scope(&state, &headers, &id, query.path).await?;
    let name = file_name(&request.path);
    let image = workspace_image_type(&name);
    let (limit, media_type) = match (inline, image) {
        (true, Some(media_type)) => (WORKSPACE_IMAGE_PREVIEW_MAX, media_type),
        (true, None) => {
            return Err(refused(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "workspace_not_an_image",
                "Only images are shown in the page; download the file instead",
            ))
        }
        (false, _) => (WORKSPACE_DOWNLOAD_MAX, "application/octet-stream"),
    };
    let reader = state
        .workspace_reader
        .clone()
        .ok_or_else(|| reader_error(ReaderError::NotConfigured))?;
    let read = reader
        .read(&request, limit, false)
        .await
        .map_err(reader_error)?;
    axum::http::Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, media_type)
        .header(header::CONTENT_LENGTH, read.length)
        .header(
            header::CONTENT_DISPOSITION,
            disposition(if inline { "inline" } else { "attachment" }, &name),
        )
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .body(read.body)
        .map_err(|_| unavailable())
}
