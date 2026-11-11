//! Request views, the one-line status text, and the checks a tab's result
//! must pass before it is recorded. A result is bound to its request: hashes
//! name exactly the requested files, a write reports exactly the queued
//! content's size and SHA-256, and an upload carries the expected filename.
use super::*;

/// The archive name of a package request (the tab must upload exactly this).
pub(super) fn package_name(request: Uuid) -> String {
    format!("selection-{}.tar", &request.simple().to_string()[..12])
}

fn place(path: Option<&str>) -> String {
    match path {
        None | Some("") => "the folder".into(),
        Some(path) => format!("\"{path}\""),
    }
}
fn failure_text(error: &str) -> String {
    let why = match error {
        "expired" => "the owner's tab did not finish it before the deadline",
        "local_files_disconnected" => "the folder was disconnected in the owner's tab",
        "local_files_grant_revoked" => "the owner revoked this thread's folder access",
        "refused_by_owner" => "the owner refused the write",
        "not_found" => "there is no such file or folder in the granted folder",
        "not_a_file" => "that path is a folder, not a file",
        "not_a_directory" => "that path is a file, not a folder",
        "too_large" => "the file is over the size limit",
        "permission_denied" => "the browser did not grant access",
        "invalid_path" => "the path cannot be used in the granted folder",
        "changed" => "the file changed while it was read",
        _ => "the owner's browser reported an error",
    };
    format!("Not done: {why} ({error}).")
}
fn status_text(
    operation: LocalFileOperation,
    state: LocalFileState,
    path: Option<&str>,
    paths: &[String],
    error: Option<&str>,
    result: Option<&LocalFileResult>,
) -> String {
    match (state, result) {
        (LocalFileState::Queued, _) => "Queued for the owner's browser tab; not done yet.".into(),
        (LocalFileState::Working, _) if operation == LocalFileOperation::Write => {
            "Waiting for the owner to confirm the write in the browser tab; not written yet.".into()
        }
        (LocalFileState::Working, _) => "The owner's browser tab is working on it.".into(),
        (LocalFileState::Failed, _) => failure_text(error.unwrap_or("browser_error")),
        (LocalFileState::Done, Some(LocalFileResult::Listing(listing))) => format!(
            "Listed {}: {} entries{}.",
            place(path),
            listing.entries.len(),
            if listing.truncated {
                " (truncated)"
            } else {
                ""
            }
        ),
        (LocalFileState::Done, Some(LocalFileResult::Hashes(hashes))) => {
            format!("Hashed {} files (SHA-256).", hashes.files.len())
        }
        (LocalFileState::Done, Some(LocalFileResult::Written(written))) => format!(
            "Wrote {} bytes to {} after the owner confirmed it.",
            written.bytes_written,
            place(path)
        ),
        (LocalFileState::Done, Some(LocalFileResult::Uploaded(uploaded))) => {
            let at = uploaded
                .local_file
                .as_deref()
                .map(|f| format!(", prepared as {f}"))
                .unwrap_or_default();
            if operation == LocalFileOperation::Package {
                format!(
                    "Packaged {} files into {} ({} bytes){at}.",
                    paths.len(),
                    uploaded.filename,
                    uploaded.byte_length
                )
            } else {
                format!("Read {}: {} bytes{at}.", place(path), uploaded.byte_length)
            }
        }
        (LocalFileState::Done, None) => "Done.".into(),
    }
}

pub(super) fn view(row: &SqliteRow) -> R<LocalFileRequestView> {
    let operation = LocalFileOperation::parse(row.get::<&str, _>("operation"))
        .ok_or(ResourceError::Unavailable)?;
    let state =
        LocalFileState::parse(row.get::<&str, _>("state")).ok_or(ResourceError::Unavailable)?;
    let paths: Vec<String> =
        serde_json::from_str(row.get::<&str, _>("paths_json")).map_err(unavailable)?;
    let result = match row.get::<Option<String>, _>("result_json") {
        None => None,
        Some(text) => Some(match operation {
            LocalFileOperation::List => {
                LocalFileResult::Listing(serde_json::from_str(&text).map_err(unavailable)?)
            }
            LocalFileOperation::Hash => {
                LocalFileResult::Hashes(serde_json::from_str(&text).map_err(unavailable)?)
            }
            LocalFileOperation::Write => {
                LocalFileResult::Written(serde_json::from_str(&text).map_err(unavailable)?)
            }
            LocalFileOperation::Read | LocalFileOperation::Package => {
                LocalFileResult::Uploaded(serde_json::from_str(&text).map_err(unavailable)?)
            }
        }),
    };
    let path: Option<String> = row.get("path");
    let error: Option<String> = row.get("error");
    Ok(LocalFileRequestView {
        request_id: uuid(row.get("id"))?,
        status_text: status_text(
            operation,
            state,
            path.as_deref(),
            &paths,
            error.as_deref(),
            result.as_ref(),
        ),
        operation,
        path,
        paths,
        state,
        error,
        content_bytes: row
            .get::<Option<i64>, _>("content_bytes")
            .map(|n| n.max(0) as u64),
        content_sha256: row.get("content_sha256"),
        created_ms: row.get("created_ms"),
        deadline_ms: row.get("deadline_ms"),
        finished_ms: row.get("finished_ms"),
        result,
    })
}

fn invalid<T>() -> R<T> {
    Err(ResourceError::Invalid)
}
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
fn members(row: &SqliteRow, finish: &LocalFileFinish) -> R<Vec<LocalFileMember>> {
    let paths: Vec<String> =
        serde_json::from_str(row.get::<&str, _>("paths_json")).map_err(unavailable)?;
    let same = finish.files.len() == paths.len()
        && finish.files.iter().zip(&paths).all(|(m, p)| &m.path == p);
    if same {
        Ok(finish.files.clone())
    } else {
        invalid()
    }
}

/// The JSON recorded as a done request's result, or `Invalid`.
pub(super) fn result_json(
    row: &SqliteRow,
    finish: &LocalFileFinish,
    upload: Option<&LocalFileUploadFacts>,
) -> R<String> {
    let operation = LocalFileOperation::parse(row.get::<&str, _>("operation"))
        .ok_or(ResourceError::Unavailable)?;
    let id = uuid(row.get("id"))?;
    let path: Option<String> = row.get("path");
    let set = [
        finish.listing.is_some(),
        finish.hashes.is_some(),
        finish.written.is_some(),
        finish.upload_id.is_some() || finish.empty,
    ];
    let expected = match operation {
        LocalFileOperation::List => 0,
        LocalFileOperation::Hash => 1,
        LocalFileOperation::Write => 2,
        LocalFileOperation::Read | LocalFileOperation::Package => 3,
    };
    // Exactly the field of this operation, and an upload only as the server
    // verified it.
    if set.iter().enumerate().any(|(i, on)| *on != (i == expected))
        || finish.upload_id != upload.map(|u| u.upload_id)
        || (finish.empty && finish.upload_id.is_some())
    {
        return invalid();
    }
    let text = match operation {
        LocalFileOperation::List => {
            let listing = finish.listing.as_ref().ok_or(ResourceError::Invalid)?;
            let names_ok = listing.entries.len() <= LOCAL_FILE_LIST_MAX
                && listing
                    .entries
                    .iter()
                    .all(|e| local_file_path(&e.name, false) && !e.name.contains('/'));
            if !names_ok {
                return invalid();
            }
            serde_json::to_string(listing)
        }
        LocalFileOperation::Hash => {
            let hashes = finish.hashes.as_ref().ok_or(ResourceError::Invalid)?;
            let paths: Vec<String> =
                serde_json::from_str(row.get::<&str, _>("paths_json")).map_err(unavailable)?;
            let ok = hashes.files.len() == paths.len()
                && hashes.files.iter().zip(&paths).all(|(d, p)| {
                    &d.path == p && hex64(&d.sha256) && d.size <= LOCAL_FILE_HASH_MAX
                });
            if !ok {
                return invalid();
            }
            serde_json::to_string(hashes)
        }
        LocalFileOperation::Write => {
            let written = finish.written.as_ref().ok_or(ResourceError::Invalid)?;
            let bytes: Option<i64> = row.get("content_bytes");
            let digest: Option<String> = row.get("content_sha256");
            if bytes != Some(written.bytes_written as i64)
                || digest.as_deref() != Some(written.sha256.as_str())
            {
                return invalid();
            }
            serde_json::to_string(written)
        }
        LocalFileOperation::Read | LocalFileOperation::Package => {
            let read = operation == LocalFileOperation::Read;
            let path = path.as_deref().unwrap_or("");
            let files = if read {
                if !finish.files.is_empty() {
                    return invalid();
                }
                vec![]
            } else {
                members(row, finish)?
            };
            let uploaded = match upload {
                None if read && finish.empty => LocalFileUploaded {
                    upload_id: None,
                    filename: local_file_name(path).into(),
                    media_type: "application/octet-stream".into(),
                    byte_length: 0,
                    sha256: Some(EMPTY_SHA256.into()),
                    local_file: None,
                    note: "The file is empty; nothing was uploaded.".into(),
                    files,
                    last_modified_ms: finish.last_modified_ms,
                },
                Some(facts) if !finish.empty => {
                    let (name, max) = if read {
                        (local_file_name(path).to_owned(), LOCAL_FILE_READ_MAX)
                    } else {
                        (package_name(id), LOCAL_FILE_PACKAGE_MAX)
                    };
                    if facts.filename != name || facts.byte_length > max || !facts.sha256_valid() {
                        return invalid();
                    }
                    LocalFileUploaded {
                        upload_id: Some(facts.upload_id),
                        filename: facts.filename.clone(),
                        media_type: facts.media_type.clone(),
                        byte_length: facts.byte_length,
                        sha256: facts.sha256.clone(),
                        local_file: facts.local_file.clone(),
                        note: facts.note.clone(),
                        files,
                        last_modified_ms: finish.last_modified_ms,
                    }
                }
                _ => return invalid(),
            };
            serde_json::to_string(&uploaded)
        }
    };
    text.map_err(unavailable)
}

/// SHA-256 of zero bytes.
pub(super) const EMPTY_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
