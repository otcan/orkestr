//! Extract opaque attachment identities from known message notes, never paths.
//! The note's file name, type and size come along as display hints for the
//! card (ORK-786); they are never authority: preview and download still load
//! and verify the conversation-scoped metadata and bytes.
use serde::Serialize;
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FileRef {
    pub kind: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}
/// `name (type, N bytes` → hints. The name may itself contain " (".
fn hints(described: &str) -> (Option<String>, Option<String>, Option<u64>) {
    let Some((name, inner)) = described.rsplit_once(" (") else {
        return (None, None, None);
    };
    let mut parts = inner.splitn(2, ", ");
    let media_type = parts.next().filter(|t| t.contains('/') && t.len() <= 255);
    let size = parts
        .next()
        .and_then(|n| n.strip_suffix(" bytes"))
        .and_then(|n| n.parse::<u64>().ok());
    let name = Some(name.trim()).filter(|n| !n.is_empty() && n.len() <= 255);
    match (name, media_type, size) {
        (Some(name), Some(media_type), Some(size)) => (
            Some(name.to_owned()),
            Some(media_type.to_owned()),
            Some(size),
        ),
        _ => (None, None, None),
    }
}
/// The quoted `name="…"` of an agent marker line, if any.
fn marker_name(line: &str) -> Option<String> {
    let start = line.find(" name=\"")? + 7;
    let end = line.rfind("\"]")?;
    (end > start)
        .then(|| line[start..end].to_owned())
        .filter(|n| n.len() <= 255)
}
fn identifier(value: &str) -> Option<String> {
    let id = value.get(..36)?;
    if id.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) {
            b == b'-'
        } else {
            b.is_ascii_hexdigit()
        }
    }) && id != "00000000-0000-0000-0000-000000000000"
    {
        Some(id.to_ascii_lowercase())
    } else {
        None
    }
}
/// A marker line the agent's reply-attach tool printed (ORK-779).
fn agent_marker(line: &str) -> Option<FileRef> {
    let (manifest, reference) = orkestr_v2_contracts::agent_attachment_ref(line)?;
    Some(FileRef {
        kind: "manifest",
        id: manifest.hyphenated().to_string(),
        reference: Some(reference.hyphenated().to_string()),
        name: marker_name(line.trim()),
        media_type: None,
        size: None,
    })
}
pub fn references(text: &str) -> Vec<FileRef> {
    let mut result = Vec::new();
    for block in text.split("\n\n") {
        let block = block.trim();
        if let Some(rest)=block.strip_prefix("[File attached in the Orkestr app, encrypted upload ") {
            if let Some(id)=identifier(rest) {
                let described = rest.get(36..).and_then(|t| t.strip_prefix(": ")).and_then(|t| t.split_once(" bytes)")).map(|(head, _)| format!("{head} bytes"));
                let (name, media_type, size) = described.as_deref().map_or((None, None, None), hints);
                result.push(FileRef{kind:"encrypted",id,reference:None,name,media_type,size});
            }
        } else if let Some(rest)=block.strip_prefix("[Files attached in the Orkestr app, manifest ")
            .or_else(||block.strip_prefix("[Files attached in the Orkestr app, stored in this conversation's attachment store, manifest "))
            .or_else(||block.strip_prefix("[WhatsApp attachments imported into this conversation's attachment store, manifest ")) {
            if let Some(id)=identifier(rest) {
                for line in rest.lines().skip(1) {
                    if let Some((head,tail))=line.split_once(", reference ") {
                        if let Some(reference)=identifier(tail){
                            let (name, media_type, size) = hints(head.trim_start().trim_start_matches("- "));
                            result.push(FileRef{kind:"manifest",id:id.clone(),reference:Some(reference),name,media_type,size});
                        }
                    }
                }
            }
        } else {
            result.extend(block.lines().filter_map(agent_marker));
        }
        if result.len() >= 8 {
            break;
        }
    }
    result.truncate(8);
    result.dedup();
    result
}
pub fn display_text(text: &str) -> String {
    text.split("\n\n")
        .filter(|block| !legacy_note(block))
        .filter_map(|block| {
            if !block.lines().any(|line| agent_marker(line).is_some()) {
                return Some(block.to_owned());
            }
            let kept: Vec<&str> = block
                .lines()
                .filter(|line| agent_marker(line).is_none())
                .collect();
            (!kept.iter().all(|line| line.trim().is_empty())).then(|| kept.join("\n"))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
/// A whole note block the app or the WhatsApp adapter appended to a message.
fn legacy_note(block: &str) -> bool {
    let block = block.trim();
    [
        "[File attached in the Orkestr app, encrypted upload ",
        "[Files attached in the Orkestr app, manifest ",
        "[Files attached in the Orkestr app, stored in this conversation's attachment store, manifest ",
        "[WhatsApp attachments imported into this conversation's attachment store, manifest ",
    ]
    .iter()
    .any(|prefix| block.starts_with(prefix))
        && !references(block).is_empty()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_recognized_notes_expose_opaque_scoped_ids() {
        let id = "00000000-0000-4000-8000-000000000001";
        let reference = "00000000-0000-4000-8000-000000000002";
        let text=format!("[Files attached in the Orkestr app, manifest {id}:\n- file.html (text/html, 12 bytes, reference {reference}, local file /private/secret)]");
        let files = references(&text);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].reference.as_deref(), Some(reference));
        assert!(!serde_json::to_string(&files).unwrap().contains("private"));
        for prefix in ["[Files attached in the Orkestr app, stored in this conversation's attachment store, manifest ", "[WhatsApp attachments imported into this conversation's attachment store, manifest "] {
            let actual=format!("{prefix}{id}:\n- file.txt (text/plain, 12 bytes, reference {reference}, local file /private/file)]");
            assert_eq!(references(&actual).len(),1);
            assert_eq!(display_text(&format!("User message\n\n{actual}")),"User message");
        }
        assert_eq!(references(&format!("[File attached in the Orkestr app, encrypted upload {id}: name.txt (text/plain, 3 bytes), SHA-256 digest, local file /private/file]"))[0].kind,"encrypted");
        assert!(references("local file /private/secret").is_empty());
        assert!(
            references("[File attached in the Orkestr app, encrypted upload ../../secret]")
                .is_empty()
        );
    }
    #[test]
    fn notes_carry_name_type_and_size_hints_but_never_paths() {
        let id = "00000000-0000-4000-8000-000000000001";
        let reference = "00000000-0000-4000-8000-000000000002";
        let manifest = format!("[Files attached in the Orkestr app, stored in this conversation's attachment store, manifest {id}:\n- Q3 (final) report.pdf (application/pdf, 2048 bytes, reference {reference}, local file /private/x.pdf)]");
        let file = &references(&manifest)[0];
        assert_eq!(file.name.as_deref(), Some("Q3 (final) report.pdf"));
        assert_eq!(file.media_type.as_deref(), Some("application/pdf"));
        assert_eq!(file.size, Some(2048));
        let encrypted = references(&format!("[File attached in the Orkestr app, encrypted upload {id}: a, b (text/plain, 2 bytes), SHA-256 digest, local file /x/y]"));
        assert_eq!(encrypted[0].name.as_deref(), Some("a, b"));
        assert_eq!(encrypted[0].media_type.as_deref(), Some("text/plain"));
        assert_eq!(encrypted[0].size, Some(2));
        let marker = references(&format!(
            "Done.\n[orkestr-attachment manifest={id} reference={reference} name=\"Checklist.md\"]"
        ));
        assert_eq!(marker[0].name.as_deref(), Some("Checklist.md"));
        assert_eq!(
            (marker[0].media_type.as_ref(), marker[0].size),
            (None, None)
        );
        let unnamed = references(&format!(
            "[orkestr-attachment manifest={id} reference={reference}]"
        ));
        assert_eq!(unnamed[0].name, None);
        // A note without a recognisable description gives no hints at all.
        let bare = references(&format!(
            "[File attached in the Orkestr app, encrypted upload {id}]"
        ));
        assert_eq!((bare[0].name.as_ref(), bare[0].size), (None, None));
        for refs in [references(&manifest), encrypted] {
            let json = serde_json::to_string(&refs).unwrap();
            assert!(
                !json.contains("/private") && !json.contains("/x/y"),
                "{json}"
            );
        }
    }
    #[test]
    fn agent_reply_markers_become_attachment_cards_and_leave_the_text() {
        let id = "00000000-0000-4000-8000-000000000001";
        let first = "00000000-0000-4000-8000-000000000002";
        let second = "00000000-0000-4000-8000-000000000003";
        let text = format!("The October package is ready.\nTwo files below.\n[orkestr-attachment manifest={id} reference={first} name=\"October.zip\"]\n[orkestr-attachment manifest={id} reference={second} name=\"Checklist.md\"]");
        let files = references(&text);
        assert_eq!(files.len(), 2);
        assert_eq!((files[0].kind, files[0].id.as_str()), ("manifest", id));
        assert_eq!(files[0].reference.as_deref(), Some(first));
        assert_eq!(files[1].reference.as_deref(), Some(second));
        assert_eq!(
            display_text(&text),
            "The October package is ready.\nTwo files below."
        );
        let alone = format!("Done.\n\n[orkestr-attachment manifest={id} reference={first}]");
        assert_eq!(references(&alone).len(), 1);
        assert_eq!(display_text(&alone), "Done.");
        // A marker quoted inside prose is not an attachment, and plain text is untouched.
        let quoted = format!("Use [orkestr-attachment manifest={id} reference={first}] later");
        assert!(references(&quoted).is_empty());
        assert_eq!(display_text(&quoted), quoted);
        assert_eq!(
            display_text("Line one\n\nLine two\n"),
            "Line one\n\nLine two\n"
        );
    }
}
