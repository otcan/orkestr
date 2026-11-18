//! The Files panel's folder view: the conversation's working folder on the
//! host, read-only (`docs/v2/workspace-files.md`). Pure presentation: paths,
//! breadcrumbs, URLs and wording. The server and the workspace reader decide
//! what may be shown.
use orkestr_v2_contracts::{WorkspaceListing, WorkspaceRootKind, WorkspaceState};

/// Percent-encode a query value (every byte outside unreserved characters).
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn list_url(conversation: &str, path: &str) -> String {
    format!(
        "/api/v2/conversations/{conversation}/workspace?path={}",
        encode(path)
    )
}
pub fn preview_url(conversation: &str, path: &str) -> String {
    format!(
        "/api/v2/conversations/{conversation}/workspace/preview?path={}",
        encode(path)
    )
}
/// The file's bytes: an attachment download, or an image shown in the page.
pub fn file_url(conversation: &str, path: &str, inline: bool) -> String {
    let base = format!(
        "/api/v2/conversations/{conversation}/workspace/file?path={}",
        encode(path)
    );
    if inline {
        format!("{base}&inline=true")
    } else {
        base
    }
}

/// `path` with `name` appended (the folder itself is the empty path).
pub fn child(path: &str, name: &str) -> String {
    if path.is_empty() {
        name.to_owned()
    } else {
        format!("{path}/{name}")
    }
}

/// The folder that contains `path`.
pub fn parent(path: &str) -> String {
    path.rsplit_once('/')
        .map_or(String::new(), |(head, _)| head.to_owned())
}

/// Breadcrumbs from the folder itself to `path`: `(label, path)` each.
pub fn crumbs(root: &str, path: &str) -> Vec<(String, String)> {
    let mut out = vec![(root.to_owned(), String::new())];
    let mut walked = String::new();
    for part in path.split('/').filter(|part| !part.is_empty()) {
        walked = child(&walked, part);
        out.push((part.to_owned(), walked.clone()));
    }
    out
}

/// `512 B`, `4.0 KB`, `1.2 MB`, `3.4 GB` (1 KB = 1024 bytes).
pub fn size_label(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// The panel's heading and the note under it.
pub fn root_heading(listing: &WorkspaceListing) -> (String, Option<&'static str>) {
    let name = listing.root_name.clone().unwrap_or_default();
    match listing.root_kind {
        Some(WorkspaceRootKind::SharedDefault) => (
            "Shared default workspace".into(),
            Some("Not this chat's own folder: every chat without its own folder works here, so files from other chats show here too."),
        ),
        Some(WorkspaceRootKind::Conversation) => (
            format!("This chat's folder · {name}"),
            None,
        ),
        None => ("This chat's folder".into(), None),
    }
}

/// What the panel says instead of a listing, if anything.
pub fn state_text(state: WorkspaceState) -> Option<&'static str> {
    match state {
        WorkspaceState::Ready => None,
        WorkspaceState::NotConfigured => Some(
            "This host cannot show the chat's folder: it has no workspace reader. The files the chat attached or sent are still listed under In this chat.",
        ),
        WorkspaceState::Unavailable => {
            Some("The chat's folder cannot be read right now. Try again in a moment.")
        }
        WorkspaceState::Missing => Some("The chat's folder does not exist yet."),
    }
}

/// `2 protected items hidden (keys, tokens, credentials)`.
pub fn hidden_note(hidden: u32) -> Option<String> {
    match hidden {
        0 => None,
        1 => Some("1 protected item hidden (keys, tokens, credentials).".into()),
        n => Some(format!(
            "{n} protected items hidden (keys, tokens, credentials)."
        )),
    }
}
