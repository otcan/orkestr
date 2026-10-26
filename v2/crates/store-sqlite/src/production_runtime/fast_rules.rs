//! Inline a binding's chat rules into a Fast turn instead of asking Fast to
//! read the file. The adapter starts an intake with one line
//!
//! `[Chat rules v<12 hex>: before answering, read <path> (cat it) unless you
//! already read this version in this session, and follow it.]`
//!
//! Every Fast session is fresh, so that line forced at least one tool call (and
//! a second model round trip) into every owner Fast reply. Fast gets the exact
//! version-checked file content instead. Deep keeps the line unchanged. Any
//! mismatch (other version, unreadable, too large, not UTF-8) keeps the line,
//! so Fast can still read the file itself.
use sha2::{Digest, Sha256};

const PREFIX: &str = "[Chat rules v";
const READ: &str = ": before answering, read ";
const SUFFIX: &str =
    " (cat it) unless you already read this version in this session, and follow it.]";
/// Keeps the Fast turn inside the Claude 32 KiB input bound with the note and
/// the bounded history digest.
pub(super) const MAX_INLINE_BYTES: u64 = 20 * 1024;

/// Largest Fast input (before Runtime's Fast note) that still fits the
/// providers' 32 KiB turn bound; Runtime asserts its note fits the reserve.
pub const FAST_INPUT_BUDGET: usize = 32_768 - FAST_NOTE_RESERVE;
pub const FAST_NOTE_RESERVE: usize = 4_096;

/// Whether a final Fast input (after handoff context and digest) fits.
pub(super) fn fits(text: &str) -> bool {
    text.len() <= FAST_INPUT_BUDGET
}

/// Only the adapter's own leading line counts: it is the very first line and
/// is followed by a blank line and the adapter's source header. Owner text
/// always follows that header, so it can never supply this line.
const SOURCE_HEADERS: [&str; 2] = ["\n[WhatsApp: ", "\n[Orkestr V1"];

/// The rules line at the start of `text`: (version, path, rest after the line).
fn parse(text: &str) -> Option<(&str, &str, &str)> {
    let rest = text.strip_prefix(PREFIX)?;
    let (line, after) = rest.split_once('\n').unwrap_or((rest, ""));
    let (version, tail) = line.split_once(READ)?;
    let path = tail.strip_suffix(SUFFIX)?;
    (version.len() == 12
        && version.bytes().all(|b| b.is_ascii_hexdigit())
        && SOURCE_HEADERS
            .iter()
            .any(|header| after.starts_with(header)))
    .then_some((version, path, after))
}

fn read(path: &str, version: &str) -> Option<String> {
    let path = std::path::Path::new(path);
    if !path.is_absolute()
        || path.extension().and_then(|e| e.to_str()) != Some("md")
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.len() > MAX_INLINE_BYTES || !operator_owned(&meta) {
        return None;
    }
    if !std::fs::symlink_metadata(path.parent()?)
        .ok()
        .is_some_and(|dir| dir.file_type().is_dir() && operator_owned(&dir))
    {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() as u64 > MAX_INLINE_BYTES {
        return None;
    }
    let digest = Sha256::digest(&bytes);
    let actual: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    if !actual[..12].eq_ignore_ascii_case(version) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Only its owner can change it: neither group- nor world-writable.
fn operator_owned(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.mode() & 0o022 == 0
}

/// Fast input with the rules line replaced by the rules themselves.
pub(super) fn inline(text: String) -> String {
    let Some((version, path, rest)) = parse(&text) else {
        return text;
    };
    let Some(rules) = read(path, version) else {
        return text;
    };
    format!(
        "[Chat rules v{version} for this chat, inlined (no need to read {path}); follow them:\n{}\n]\n{rest}",
        rules.trim_end()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(version: &str, path: &str) -> String {
        format!("{PREFIX}{version}{READ}{path}{SUFFIX}")
    }

    fn version(content: &[u8]) -> String {
        Sha256::digest(content)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()[..12]
            .to_owned()
    }

    #[test]
    fn exact_version_is_inlined_and_the_rest_is_unchanged() {
        let dir = std::env::temp_dir().join(format!("synthetic-fast-rules-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chat.md");
        let content = b"# Synthetic chat rules\n\nReply in English.\n";
        std::fs::write(&path, content).unwrap();
        use std::os::unix::fs::PermissionsExt;
        // Independent of the test process umask.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let path = path.to_str().unwrap().to_owned();
        let body = "\n[WhatsApp: synthetic]\n\nhello\n\n[WhatsApp attachments imported ...: local file /synthetic/a.jpg]";
        let input = format!("{}\n{body}", line(&version(content), &path));
        let inlined = inline(input.clone());
        assert!(inlined.contains("Reply in English."));
        assert!(!inlined.contains("(cat it)"));
        assert!(inlined.ends_with(body), "message and attachments unchanged");
        // Another version, or no rules line, keeps the input exactly.
        let stale = format!("{}\n{body}", line("0123456789ab", &path));
        assert_eq!(inline(stale.clone()), stale);
        assert_eq!(inline(body.to_owned()), body);
        // Too large keeps the line: Fast may still read the file itself.
        let big = vec![b'x'; MAX_INLINE_BYTES as usize + 1];
        std::fs::write(dir.join("big.md"), &big).unwrap();
        let big_line = format!(
            "{}\n{body}",
            line(&version(&big), dir.join("big.md").to_str().unwrap())
        );
        assert_eq!(inline(big_line.clone()), big_line);
        // Without the adapter's source header right after it, the line is owner
        // text (or a non-adapter intake) and is never honoured.
        let typed = format!("{}\n\nhello", line(&version(content), &path));
        assert_eq!(inline(typed.clone()), typed);
        // A rules file others can write is never inlined.
        std::fs::set_permissions(dir.join("chat.md"), std::fs::Permissions::from_mode(0o666))
            .unwrap();
        assert_eq!(inline(input.clone()), input);
        std::fs::set_permissions(dir.join("chat.md"), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        assert_ne!(inline(input.clone()), input);
        // Only absolute .md paths without parent components.
        assert!(read("relative.md", "000000000000").is_none());
        assert!(read("/etc/passwd", "000000000000").is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn budget_leaves_room_for_the_fast_note() {
        assert!(fits(&"x".repeat(FAST_INPUT_BUDGET)));
        assert!(!fits(&"x".repeat(FAST_INPUT_BUDGET + 1)));
        assert_eq!(FAST_INPUT_BUDGET + FAST_NOTE_RESERVE, 32_768);
    }
}
