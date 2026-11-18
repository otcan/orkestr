//! Read-only view of a conversation's working folder on the host: the Files
//! panel's file browser (`docs/v2/workspace-files.md`).
//!
//! Core never opens the folder. A reader on the side that already has access
//! resolves the folder from the operator's runtime plan and enforces the
//! confinement and protected names; Core repeats the cheap path checks here
//! so a refused path never leaves it, and drops any protected name a reader
//! might still report.
use crate::ConversationId;
use serde::{Deserialize, Serialize};

pub const WORKSPACE_PATH_BYTES_MAX: usize = 4096;
pub const WORKSPACE_PATH_PARTS_MAX: usize = 64;
/// Entries one folder listing shows (folders first, newest first).
pub const WORKSPACE_LIST_MAX: usize = 1000;
/// Text previews read at most this much of a file.
pub const WORKSPACE_TEXT_PREVIEW_MAX: u64 = 512 * 1024;
/// Images larger than this are not previewed (they can still be downloaded).
pub const WORKSPACE_IMAGE_PREVIEW_MAX: u64 = 10 * 1024 * 1024;
/// Largest file a download serves.
pub const WORKSPACE_DOWNLOAD_MAX: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceEntryKind {
    Dir,
    File,
    Link,
    Other,
}

/// Where a symlink in the folder leads. Only `dir` and `file` open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceLinkTarget {
    Dir,
    File,
    Other,
    Outside,
    Broken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceEntry {
    pub name: String,
    pub kind: WorkspaceEntryKind,
    /// Bytes, for a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub modified_ms: i64,
    /// For a link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<WorkspaceLinkTarget>,
}
impl WorkspaceEntry {
    pub fn opens_as_folder(&self) -> bool {
        self.kind == WorkspaceEntryKind::Dir
            || (self.kind == WorkspaceEntryKind::Link
                && self.target == Some(WorkspaceLinkTarget::Dir))
    }
    pub fn opens_as_file(&self) -> bool {
        self.kind == WorkspaceEntryKind::File
            || (self.kind == WorkspaceEntryKind::Link
                && self.target == Some(WorkspaceLinkTarget::File))
    }
    pub fn is_valid(&self) -> bool {
        workspace_name_shown(&self.name)
            && self.modified_ms >= 0
            && (self.kind == WorkspaceEntryKind::File) == self.size.is_some()
            && (self.kind == WorkspaceEntryKind::Link) == self.target.is_some()
    }
}

/// Whose folder this is. Every chat without its own pinned folder works in
/// the same shared default one; the panel says so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRootKind {
    Conversation,
    SharedDefault,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceState {
    Ready,
    /// This host has no workspace reader: the folder cannot be shown here.
    NotConfigured,
    /// The reader did not answer, or may not read the folder.
    Unavailable,
    /// The folder does not exist (yet).
    Missing,
}

/// `GET /api/v2/conversations/{id}/workspace?path=`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceListing {
    pub conversation_id: ConversationId,
    pub state: WorkspaceState,
    #[serde(default)]
    pub root_kind: Option<WorkspaceRootKind>,
    /// The folder's own name (never its full host path).
    #[serde(default)]
    pub root_name: Option<String>,
    /// Relative to the folder; empty for the folder itself.
    pub path: String,
    pub entries: Vec<WorkspaceEntry>,
    /// Protected entries (keys, tokens, credentials, ...) left out here.
    pub hidden: u32,
    /// More than `WORKSPACE_LIST_MAX` entries: the oldest files are left out.
    pub truncated: bool,
}
impl WorkspaceListing {
    pub fn is_valid(&self) -> bool {
        (self.path.is_empty() || workspace_path_parts(&self.path).is_ok())
            && self.entries.len() <= WORKSPACE_LIST_MAX
            && self.entries.iter().all(WorkspaceEntry::is_valid)
            && (self.state == WorkspaceState::Ready || self.entries.is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspacePreview {
    /// UTF-8 text; `truncated` when only the first
    /// `WORKSPACE_TEXT_PREVIEW_MAX` bytes are shown.
    Text { text: String, truncated: bool },
    /// Shown from the file route with `inline=true`.
    Image { media_type: String },
    /// Not text and not a previewable image: download only.
    Binary,
    /// An image above `WORKSPACE_IMAGE_PREVIEW_MAX`.
    TooLarge,
}

/// `GET /api/v2/conversations/{id}/workspace/preview?path=`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceFilePreview {
    pub conversation_id: ConversationId,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: i64,
    /// Whether a download may serve it (at most `WORKSPACE_DOWNLOAD_MAX`).
    pub downloadable: bool,
    pub preview: WorkspacePreview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspacePathError {
    Invalid,
    Absolute,
    Traversal,
    Protected,
}

/// A name a listing may show and a path part may use.
pub fn workspace_name_shown(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.chars().any(char::is_control)
        && !workspace_name_protected(name)
}

/// The parts of a folder-relative path; the empty path is the folder itself.
pub fn workspace_path_parts(path: &str) -> Result<Vec<&str>, WorkspacePathError> {
    if path.len() > WORKSPACE_PATH_BYTES_MAX {
        return Err(WorkspacePathError::Invalid);
    }
    if path.is_empty() {
        return Ok(Vec::new());
    }
    if path.starts_with('/') {
        return Err(WorkspacePathError::Absolute);
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() > WORKSPACE_PATH_PARTS_MAX {
        return Err(WorkspacePathError::Invalid);
    }
    if parts.iter().any(|part| matches!(*part, "." | "..")) {
        return Err(WorkspacePathError::Traversal);
    }
    if parts
        .iter()
        .any(|part| part.is_empty() || part.chars().any(char::is_control))
    {
        return Err(WorkspacePathError::Invalid);
    }
    if parts.iter().any(|part| workspace_name_protected(part)) {
        return Err(WorkspacePathError::Protected);
    }
    Ok(parts)
}

const PROTECTED_NAMES: [&str; 31] = [
    ".ssh",
    ".gnupg",
    ".gpg",
    ".codex",
    ".claude",
    ".claude.json",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".gcloud",
    ".password-store",
    ".vault-token",
    ".netrc",
    "_netrc",
    ".npmrc",
    ".pypirc",
    ".pgpass",
    ".git-credentials",
    ".htpasswd",
    ".my.cnf",
    "auth.json",
    ".credentials.json",
    "secrets",
    ".secrets",
    "keyring",
    "keyrings",
    ".keyrings",
    "known_hosts",
    "authorized_keys",
    ".env",
];
const PROTECTED_PREFIXES: [&str; 5] = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".env."];
const PROTECTED_SUFFIXES: [&str; 9] = [
    ".env",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".jks",
    ".keystore",
    ".kdbx",
    ".ppk",
];
const PROTECTED_FRAGMENTS: [&str; 6] = [
    "credential",
    "secret",
    "passw",
    "private_key",
    "private-key",
    "privatekey",
];
const PROTECTED_WORDS: [&str; 6] = ["token", "tokens", "creds", "apikey", "apikeys", "passwd"];
const PROTECTED_PAIRS: [(&str, &str); 6] = [
    ("api", "key"),
    ("api", "keys"),
    ("access", "key"),
    ("private", "key"),
    ("auth", "token"),
    ("session", "key"),
];

/// Lowercase words of a name, split at punctuation and at a lower-to-upper
/// camelCase step (`authToken.json` is `auth`, `token`, `json`).
fn name_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut previous: Option<char> = None;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            let step = c.is_ascii_uppercase()
                && previous.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit());
            if step && !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            word.push(c.to_ascii_lowercase());
        } else if !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        previous = Some(c);
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

/// Secret-shaped names (keys, tokens, credentials, `.env` files, `.ssh`,
/// `.codex`, ...) are never listed or opened, at any depth. The workspace
/// reader applies the same list.
pub fn workspace_name_protected(name: &str) -> bool {
    let lower = name.to_lowercase();
    if PROTECTED_NAMES.contains(&lower.as_str())
        || PROTECTED_PREFIXES.iter().any(|p| lower.starts_with(p))
        || PROTECTED_SUFFIXES.iter().any(|s| lower.ends_with(s))
        || PROTECTED_FRAGMENTS.iter().any(|f| lower.contains(f))
    {
        return true;
    }
    let words = name_words(name);
    words.iter().any(|w| PROTECTED_WORDS.contains(&w.as_str()))
        || words.windows(2).any(|pair| {
            PROTECTED_PAIRS
                .iter()
                .any(|(a, b)| pair[0] == *a && pair[1] == *b)
        })
}

/// The media type of a previewable image, by extension. SVG is not one: it
/// can carry script, so it is shown as text instead.
pub fn workspace_image_type(name: &str) -> Option<&'static str> {
    let extension = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// The text of a preview read, if it is text: UTF-8 without NUL. When the
/// read stopped early (`truncated`), a multi-byte character cut at the end
/// is dropped.
pub fn workspace_text(bytes: &[u8], truncated: bool) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Some(text.to_owned()),
        Err(error)
            if truncated
                && error.error_len().is_none()
                && bytes.len() - error.valid_up_to() < 4 =>
        {
            Some(String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned())
        }
        Err(_) => None,
    }
}

#[cfg(test)]
#[path = "workspace_files_tests.rs"]
mod tests;
