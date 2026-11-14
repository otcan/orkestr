//! Files a running Deep turn attaches to its own reply (ORK-779).
//!
//! The agent uploads a file of its workspace with the reply-attach tool
//! (`POST /api/v2/conversations/{id}/agent-attachments`, the conversation's
//! agent grant). The server stores it in the conversation's attachment store
//! and answers with one marker line per file. The agent ends its reply with
//! those lines: the web chat shows each as an attachment card, and the
//! WhatsApp adapter strips them from the text and sends the files with the
//! reply to the chat's own WhatsApp group. A marker carries opaque scoped IDs
//! only, never a path; it grants nothing by itself.
use uuid::Uuid;

/// Attachment store request keys of agent attachments start with this. Only
/// the agent attachment route writes them; the adapter sends a file to
/// WhatsApp only from a manifest imported under this prefix.
pub const AGENT_ATTACHMENT_REQUEST_PREFIX: &str = "agent-attach:";
/// One marker line per file: `[orkestr-attachment manifest=<id> reference=<id> name="<name>"]`.
pub const AGENT_ATTACHMENT_MARKER_PREFIX: &str = "[orkestr-attachment manifest=";
/// Files of one reply, over all its markers (the web chat shows at most 8).
pub const AGENT_ATTACHMENT_FILES_MAX: usize = 8;
/// Files of one reply in all: the attachment store's limit (`ATTACHMENT_MAX_BYTES`).
/// The WhatsApp worker takes up to 64 MB per file (`whatsapp-scoped-reply-files.js`).
pub const AGENT_ATTACHMENT_BYTES_MAX: usize = 16 * 1024 * 1024;

/// Common file types by lowercase extension: a file with one of these
/// extensions must carry that type. An agent may attach any other file the
/// attachment store takes (ORK-787). WhatsApp gets every file, of any type,
/// as media or as a document (ORK-827).
pub const AGENT_ATTACHMENT_TYPES: &[(&str, &str)] = &[
    ("pdf", "application/pdf"),
    (
        "xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    ("xls", "application/vnd.ms-excel"),
    (
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    (
        "pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
    ("csv", "text/csv"),
    ("txt", "text/plain"),
    ("md", "text/markdown"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("zip", "application/zip"),
];

/// The media type for `filename`, when its extension is an allowed one and
/// `media_type` (when given) is that extension's type.
pub fn agent_attachment_type(filename: &str, media_type: Option<&str>) -> Option<&'static str> {
    let extension = filename.rsplit_once('.')?.1.to_ascii_lowercase();
    let (_, expected) = AGENT_ATTACHMENT_TYPES
        .iter()
        .find(|(ext, _)| *ext == extension)?;
    media_type
        .is_none_or(|m| m == *expected)
        .then_some(*expected)
}

/// A file of a WhatsApp extension must carry that extension's type; any other
/// file keeps the type it was uploaded with.
pub fn agent_attachment_type_consistent(filename: &str, media_type: &str) -> bool {
    let extension = filename
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase());
    match extension.and_then(|e| AGENT_ATTACHMENT_TYPES.iter().find(|(ext, _)| *ext == e)) {
        Some((_, expected)) => *expected == media_type,
        None => true,
    }
}

/// Never a hidden file or a secret-looking one (keys, key stores, credentials).
pub fn agent_attachment_name_allowed(filename: &str) -> bool {
    let lower = filename.to_ascii_lowercase();
    let secret_extension = [".pem", ".key", ".p12", ".pfx", ".kdbx"]
        .iter()
        .any(|e| lower.ends_with(e));
    let secret_config = [
        "credential",
        "credentials",
        "token",
        "tokens",
        "secret",
        "secrets",
    ]
    .iter()
    .any(|stem| {
        ["json", "yaml", "yml", "toml", "ini"]
            .iter()
            .any(|ext| lower == format!("{stem}.{ext}"))
    });
    let ssh_key = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
        .iter()
        .any(|k| lower == *k || lower.starts_with(&format!("{k}.")));
    !filename.starts_with('.')
        && !secret_extension
        && !secret_config
        && !ssh_key
        && lower != "kubeconfig"
}

/// The display name inside a marker: no quotes, brackets or control
/// characters, at most 120 characters.
fn marker_name(filename: &str) -> String {
    filename
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '"' | '[' | ']') {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect()
}

pub fn agent_attachment_marker(manifest: Uuid, reference: Uuid, filename: &str) -> String {
    format!(
        "{AGENT_ATTACHMENT_MARKER_PREFIX}{} reference={} name=\"{}\"]",
        manifest.hyphenated(),
        reference.hyphenated(),
        marker_name(filename)
    )
}

fn identifier(value: &str) -> Option<Uuid> {
    let id = value.get(..36)?;
    Uuid::parse_str(id)
        .ok()
        .filter(|u| !u.is_nil() && u.hyphenated().to_string() == id.to_ascii_lowercase())
}

/// `(manifest, reference)` when `line` is exactly one marker line.
pub fn agent_attachment_ref(line: &str) -> Option<(Uuid, Uuid)> {
    let rest = line.trim().strip_prefix(AGENT_ATTACHMENT_MARKER_PREFIX)?;
    let manifest = identifier(rest)?;
    let rest = rest.get(36..)?.strip_prefix(" reference=")?;
    let reference = identifier(rest)?;
    let tail = rest.get(36..)?;
    let closed = tail == "]" || (tail.starts_with(' ') && tail.ends_with(']'));
    (closed && !tail[..tail.len() - 1].contains([']', '\n'])).then_some((manifest, reference))
}

/// Every marker of a text, in order, without repeats, at most
/// `AGENT_ATTACHMENT_FILES_MAX`.
pub fn agent_attachment_refs(text: &str) -> Vec<(Uuid, Uuid)> {
    let mut found = Vec::new();
    for pair in text.lines().filter_map(agent_attachment_ref) {
        if !found.contains(&pair) {
            found.push(pair);
        }
        if found.len() == AGENT_ATTACHMENT_FILES_MAX {
            break;
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_round_trip_and_only_exact_lines_count() {
        let manifest = Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap();
        let reference = Uuid::parse_str("00000000-0000-4000-8000-000000000002").unwrap();
        let line = agent_attachment_marker(manifest, reference, "Report \"Q3\" [draft].pdf");
        assert_eq!(
            line,
            "[orkestr-attachment manifest=00000000-0000-4000-8000-000000000001 reference=00000000-0000-4000-8000-000000000002 name=\"Report _Q3_ _draft_.pdf\"]"
        );
        assert_eq!(agent_attachment_ref(&line), Some((manifest, reference)));
        assert_eq!(
            agent_attachment_ref(&format!("  {line}  ")),
            Some((manifest, reference))
        );
        let bare = format!("[orkestr-attachment manifest={manifest} reference={reference}]");
        assert_eq!(agent_attachment_ref(&bare), Some((manifest, reference)));
        for refused in [
            format!("See {line}"),
            line.replace(" reference=", " ref="),
            line.trim_end_matches(']').to_owned(),
            format!("[orkestr-attachment manifest={manifest} reference=00000000-0000-0000-0000-000000000000]"),
            format!("[orkestr-attachment manifest=../../{manifest} reference={reference}]"),
            format!("[orkestr-attachment manifest={manifest} reference={reference}x]"),
        ] {
            assert_eq!(agent_attachment_ref(&refused), None, "{refused}");
        }
        let text = format!("Here is the package.\n\n{line}\n{line}\n{bare}");
        assert_eq!(agent_attachment_refs(&text), vec![(manifest, reference)]);
    }

    #[test]
    fn only_whatsapp_types_are_allowed() {
        assert_eq!(
            agent_attachment_type("a.PDF", None),
            Some("application/pdf")
        );
        assert_eq!(
            agent_attachment_type("a.zip", Some("application/zip")),
            Some("application/zip")
        );
        assert_eq!(
            agent_attachment_type("a.zip", Some("application/pdf")),
            None
        );
        assert_eq!(agent_attachment_type("a.exe", None), None);
        assert_eq!(agent_attachment_type("noextension", None), None);
        assert_eq!(agent_attachment_type("a.html", Some("text/html")), None);
    }

    #[test]
    fn any_store_file_but_consistent_types_and_no_secrets() {
        assert!(agent_attachment_type_consistent("page.html", "text/html"));
        assert!(agent_attachment_type_consistent(
            "blob",
            "application/octet-stream"
        ));
        assert!(agent_attachment_type_consistent("a.PDF", "application/pdf"));
        assert!(!agent_attachment_type_consistent(
            "a.pdf",
            "application/zip"
        ));
        for name in [
            "report.pdf",
            "keyring-notes.md",
            "tokens-2026.csv",
            "page.html",
        ] {
            assert!(agent_attachment_name_allowed(name), "{name}");
        }
        for name in [
            ".env",
            "server.pem",
            "TLS.KEY",
            "id_rsa",
            "id_ed25519.pub",
            "credentials.json",
            "secrets.yaml",
            "kubeconfig",
        ] {
            assert!(!agent_attachment_name_allowed(name), "{name}");
        }
    }
}
