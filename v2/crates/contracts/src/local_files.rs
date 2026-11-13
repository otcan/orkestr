//! Local folder relay (ORK-750, proof of concept). A running Deep turn queues
//! file requests for its OWN conversation (list, read, hash, write, package).
//! Only the owner's open browser tab that granted a folder for that
//! conversation performs them, inside that folder only, and returns the
//! result. Bytes read from the folder reach the server only through the
//! encrypted upload path; a write carries its content in the request and
//! needs the owner's confirmation in the tab. No request names a
//! conversation: it always comes from the grant.
use crate::ConversationId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Header carrying a per-conversation local-files grant (64 lowercase hex).
pub const LOCAL_FILES_GRANT_HEADER: &str = "x-orkestr-local-files-grant";
/// Relative path limits, in bytes (UTF-8).
pub const LOCAL_FILE_PATH_MAX: usize = 1024;
pub const LOCAL_FILE_NAME_MAX: usize = 255;
pub const LOCAL_FILE_DEPTH_MAX: usize = 32;
/// Files named by one hash or package request.
pub const LOCAL_FILE_PATHS_MAX: usize = 64;
/// Entries returned by one listing (one directory, not recursive).
pub const LOCAL_FILE_LIST_MAX: usize = 1000;
/// Decoded content of one write.
pub const LOCAL_FILE_WRITE_MAX: usize = 1024 * 1024;
/// One file read through the encrypted upload path.
pub const LOCAL_FILE_READ_MAX: u64 = 64 * 1024 * 1024;
/// One package (an uncompressed tar of the selection).
pub const LOCAL_FILE_PACKAGE_MAX: u64 = 64 * 1024 * 1024;
/// One hashed file (the tab hashes it in memory).
pub const LOCAL_FILE_HASH_MAX: u64 = 128 * 1024 * 1024;
/// Request deadline: default, minimum and maximum.
pub const LOCAL_FILE_TIMEOUT_MS: i64 = 120_000;
pub const LOCAL_FILE_TIMEOUT_MIN_MS: i64 = 5_000;
pub const LOCAL_FILE_TIMEOUT_MAX_MS: i64 = 600_000;
/// Requests the connected tab works on at once. More wait queued on the
/// server and are handed out as these finish (ORK-810).
pub const LOCAL_FILE_OPEN_MAX: i64 = 8;
/// Unfinished requests (queued or in progress) per conversation: a batch of
/// writes is queued, not refused (ORK-810).
pub const LOCAL_FILE_QUEUE_MAX: i64 = 64;
/// Requests per conversation per 10 minutes.
pub const LOCAL_FILE_RECENT_MAX: i64 = 120;
/// A tab that has not polled for this long is no longer connected. Chrome
/// may wake a hidden tab only once a minute, so this is above a minute.
pub const LOCAL_FILE_CONNECTION_TTL_MS: i64 = 75_000;
/// Codes the tab may report for a failed request.
pub const LOCAL_FILE_BROWSER_ERRORS: &[&str] = &[
    "not_found",
    "not_a_file",
    "not_a_directory",
    "too_large",
    "refused_by_owner",
    "permission_denied",
    "invalid_path",
    "changed",
    "browser_error",
];

fn key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A path relative to the granted folder: `/`-separated names, never empty,
/// `.` or `..`, no leading or trailing `/`, no backslash or control
/// character. The empty path is the folder itself (only a listing may name it).
pub fn local_file_path(path: &str, root_allowed: bool) -> bool {
    if path.is_empty() {
        return root_allowed;
    }
    if path.len() > LOCAL_FILE_PATH_MAX || path.contains('\\') || path.chars().any(char::is_control)
    {
        return false;
    }
    let parts: Vec<&str> = path.split('/').collect();
    parts.len() <= LOCAL_FILE_DEPTH_MAX
        && parts
            .iter()
            .all(|p| !p.is_empty() && *p != "." && *p != ".." && p.len() <= LOCAL_FILE_NAME_MAX)
}
/// The last name of a valid non-empty path.
pub fn local_file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalFileOperation {
    List,
    Read,
    Hash,
    Write,
    Package,
}
impl LocalFileOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Read => "read",
            Self::Hash => "hash",
            Self::Write => "write",
            Self::Package => "package",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        [
            Self::List,
            Self::Read,
            Self::Hash,
            Self::Write,
            Self::Package,
        ]
        .into_iter()
        .find(|op| op.as_str() == value)
    }
}

/// `POST /api/v2/conversations/{id}/local-files/requests` (grant holder).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFileRequestCreate {
    /// Idempotency key, scoped to the asking run: the same key with the same
    /// body is the same request, with another body a conflict.
    pub request_key: String,
    pub operation: LocalFileOperation,
    /// `list` (may be "" for the folder), `read` and `write`.
    #[serde(default)]
    pub path: Option<String>,
    /// `hash` and `package`: 1 to 64 distinct files.
    #[serde(default)]
    pub paths: Vec<String>,
    /// `write` only: standard base64 of the new file content.
    #[serde(default)]
    pub content_base64: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<i64>,
}
impl LocalFileRequestCreate {
    pub fn is_valid(&self) -> bool {
        let one = |root| {
            self.path
                .as_deref()
                .is_some_and(|p| local_file_path(p, root))
                && self.paths.is_empty()
        };
        let many = || {
            self.path.is_none()
                && !self.paths.is_empty()
                && self.paths.len() <= LOCAL_FILE_PATHS_MAX
                && self.paths.iter().all(|p| local_file_path(p, false))
                && self
                    .paths
                    .iter()
                    .enumerate()
                    .all(|(i, p)| !self.paths[..i].contains(p))
        };
        let content = self.content_base64.as_deref();
        let shape = match self.operation {
            LocalFileOperation::List => one(true) && content.is_none(),
            LocalFileOperation::Read => one(false) && content.is_none(),
            LocalFileOperation::Hash | LocalFileOperation::Package => many() && content.is_none(),
            LocalFileOperation::Write => {
                one(false)
                    && content.is_some_and(|c| c.len() <= LOCAL_FILE_WRITE_MAX.div_ceil(3) * 4)
            }
        };
        key(&self.request_key)
            && shape
            && self.timeout_ms.is_none_or(|t| {
                (LOCAL_FILE_TIMEOUT_MIN_MS..=LOCAL_FILE_TIMEOUT_MAX_MS).contains(&t)
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalFileState {
    /// Waiting for the connected tab.
    Queued,
    /// The tab took it (and, for a write, may be waiting for the owner).
    Working,
    Done,
    Failed,
}
impl LocalFileState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Working => "working",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        [Self::Queued, Self::Working, Self::Done, Self::Failed]
            .into_iter()
            .find(|state| state.as_str() == value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalFileKind {
    File,
    Directory,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFileEntry {
    pub name: String,
    pub kind: LocalFileKind,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub last_modified_ms: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFileListing {
    pub entries: Vec<LocalFileEntry>,
    pub truncated: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFileDigest {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFileHashes {
    pub files: Vec<LocalFileDigest>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFileWritten {
    pub bytes_written: u64,
    pub sha256: String,
    /// True when the file did not exist before.
    pub created: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFileMember {
    pub path: String,
    pub size: u64,
}
/// A read or package result: the file the server prepared from the
/// encrypted upload (never bytes in this JSON).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFileUploaded {
    /// None for an empty file (nothing is uploaded).
    pub upload_id: Option<Uuid>,
    pub filename: String,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: Option<String>,
    /// The prepared file the agent can open on the server.
    pub local_file: Option<String>,
    pub note: String,
    /// Package members (empty for a read).
    pub files: Vec<LocalFileMember>,
    pub last_modified_ms: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LocalFileResult {
    Listing(LocalFileListing),
    Hashes(LocalFileHashes),
    Written(LocalFileWritten),
    Uploaded(LocalFileUploaded),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFileRequestView {
    pub request_id: Uuid,
    pub operation: LocalFileOperation,
    pub path: Option<String>,
    pub paths: Vec<String>,
    pub state: LocalFileState,
    /// Why it failed: a tab code (`LOCAL_FILE_BROWSER_ERRORS`), `expired`
    /// or `local_files_disconnected`.
    pub error: Option<String>,
    pub content_bytes: Option<u64>,
    pub content_sha256: Option<String>,
    pub created_ms: i64,
    pub deadline_ms: i64,
    pub finished_ms: Option<i64>,
    pub result: Option<LocalFileResult>,
    /// One honest line to relay to the owner.
    pub status_text: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFileReceipt {
    /// False for a replay of the same key and body.
    pub created: bool,
    pub request: LocalFileRequestView,
}

/// `POST .../local-files/poll` (owner's browser tab): heartbeat plus the
/// requests this tab should perform now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFilePoll {
    pub connection_id: Uuid,
    pub folder_name: String,
    /// Replace a live connection of another tab (the owner chose this tab).
    #[serde(default)]
    pub takeover: bool,
}
impl LocalFilePoll {
    pub fn is_valid(&self) -> bool {
        !self.connection_id.is_nil()
            && !self.folder_name.trim().is_empty()
            && self.folder_name.len() <= LOCAL_FILE_NAME_MAX
            && !self.folder_name.chars().any(char::is_control)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFilePollReply {
    /// Every unfinished request this tab holds (it keeps its own progress).
    pub requests: Vec<LocalFileRequestView>,
    pub ttl_ms: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFileDisconnect {
    pub connection_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalFileOutcome {
    Done,
    Failed,
}
/// `POST .../local-files/requests/{request}/result` (owner's browser tab).
/// Exactly the field of the request's operation is set for `done`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFileFinish {
    pub connection_id: Uuid,
    pub outcome: LocalFileOutcome,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub listing: Option<LocalFileListing>,
    #[serde(default)]
    pub hashes: Option<LocalFileHashes>,
    #[serde(default)]
    pub written: Option<LocalFileWritten>,
    /// `read` and `package`: the completed and prepared encrypted upload.
    #[serde(default)]
    pub upload_id: Option<Uuid>,
    /// `read` of an empty file: nothing is uploaded.
    #[serde(default)]
    pub empty: bool,
    #[serde(default)]
    pub files: Vec<LocalFileMember>,
    #[serde(default)]
    pub last_modified_ms: Option<i64>,
}
impl LocalFileFinish {
    pub fn error_valid(&self) -> bool {
        match self.outcome {
            LocalFileOutcome::Failed => self
                .error
                .as_deref()
                .is_some_and(|e| LOCAL_FILE_BROWSER_ERRORS.contains(&e)),
            LocalFileOutcome::Done => self.error.is_none(),
        }
    }
}
/// What the server verified about an upload before the store records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFileUploadFacts {
    pub upload_id: Uuid,
    pub filename: String,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: Option<String>,
    pub local_file: Option<String>,
    pub note: String,
}
impl LocalFileUploadFacts {
    pub fn sha256_valid(&self) -> bool {
        self.sha256.as_deref().is_none_or(hex64)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFileGrant {
    pub conversation_id: ConversationId,
    pub issued: bool,
    pub generation: i64,
}
/// Returned once at issue; only its hash is stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalFileGrantIssued {
    pub grant: String,
    pub binding: LocalFileGrant,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFileConnection {
    pub folder_name: String,
    pub connected_ms: i64,
    pub seen_ms: i64,
    pub live: bool,
}
/// `GET .../local-files` (owner): grant state, connection and request log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFilesOverview {
    pub grant: LocalFileGrant,
    pub connection: Option<LocalFileConnection>,
    pub requests: Vec<LocalFileRequestView>,
}

#[cfg(test)]
#[path = "local_files_tests.rs"]
mod tests;
