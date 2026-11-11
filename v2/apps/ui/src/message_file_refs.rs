//! Extract opaque attachment identities from known message notes, never paths.
use serde::Serialize;
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FileRef {
    pub kind: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
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
    })
}
pub fn references(text: &str) -> Vec<FileRef> {
    let mut result = Vec::new();
    for block in text.split("\n\n") {
        let block = block.trim();
        if let Some(rest)=block.strip_prefix("[File attached in the Orkestr app, encrypted upload ") {
            if let Some(id)=identifier(rest) {result.push(FileRef{kind:"encrypted",id,reference:None});}
        } else if let Some(rest)=block.strip_prefix("[Files attached in the Orkestr app, manifest ")
            .or_else(||block.strip_prefix("[Files attached in the Orkestr app, stored in this conversation's attachment store, manifest "))
            .or_else(||block.strip_prefix("[WhatsApp attachments imported into this conversation's attachment store, manifest ")) {
            if let Some(id)=identifier(rest) {
                for line in rest.lines().skip(1) {
                    if let Some((_,tail))=line.split_once(", reference ") {
                        if let Some(reference)=identifier(tail){result.push(FileRef{kind:"manifest",id:id.clone(),reference:Some(reference)});}
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
