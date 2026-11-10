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
        .filter(|block| references(block).is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
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
}
