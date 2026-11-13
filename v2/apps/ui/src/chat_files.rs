//! "In this chat" of a conversation's Files panel (ORK-809): every file the
//! owner attached and every file the assistant sent, newest first, each once.
//! Built from the messages the chat has loaded (the same notes and markers
//! that give each message its file cards), so it lists exactly what the
//! transcript shows and needs no request of its own.
use crate::message_file_refs::{references, FileRef};
use serde::Serialize;

/// Files listed at most; older ones stay on their messages in the chat.
pub const CHAT_FILES_MAX: usize = 60;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ChatFile {
    /// Who sent it: "You", "Assistant" or the message's author.
    pub from: String,
    /// The message's place in the conversation (newest is largest).
    pub sequence: i64,
    #[serde(flatten)]
    pub file: FileRef,
}

/// `messages` are `(sequence, from, text)` in any order. The result is newest
/// first; a file named by several messages is listed once, at its newest.
pub fn newest_first<'a>(
    messages: impl IntoIterator<Item = (i64, String, &'a str)>,
) -> Vec<ChatFile> {
    let mut found: Vec<(i64, String, &'a str)> = messages.into_iter().collect();
    found.sort_by_key(|a| std::cmp::Reverse(a.0));
    let mut files: Vec<ChatFile> = Vec::new();
    for (sequence, from, text) in found {
        for file in references(text) {
            let seen = files.iter().any(|known| {
                known.file.kind == file.kind
                    && known.file.id == file.id
                    && known.file.reference == file.reference
            });
            if !seen {
                files.push(ChatFile {
                    from: from.clone(),
                    sequence,
                    file,
                });
            }
            if files.len() >= CHAT_FILES_MAX {
                return files;
            }
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: &str = "00000000-0000-4000-8000-000000000001";
    const R1: &str = "00000000-0000-4000-8000-000000000002";
    const R2: &str = "00000000-0000-4000-8000-000000000003";
    const U: &str = "00000000-0000-4000-8000-000000000004";

    #[test]
    fn owner_and_assistant_files_newest_first_each_once() {
        let owner = format!("Please check this.\n\n[File attached in the Orkestr app, encrypted upload {U}: plan.txt (text/plain, 12 bytes), SHA-256 digest, local file /synthetic/plan.txt]");
        let reply = format!("Done.\n[orkestr-attachment manifest={M} reference={R1} name=\"report.pdf\"]\n[orkestr-attachment manifest={M} reference={R2} name=\"table.csv\"]");
        let again = format!("Same report again.\n[orkestr-attachment manifest={M} reference={R1} name=\"report.pdf\"]");
        let files = newest_first([
            (3, "Assistant".to_string(), reply.as_str()),
            (1, "You".to_string(), owner.as_str()),
            (2, "You".to_string(), "No files here."),
            (7, "Assistant".to_string(), again.as_str()),
        ]);
        let shown: Vec<(&str, i64, Option<&str>)> = files
            .iter()
            .map(|f| (f.from.as_str(), f.sequence, f.file.name.as_deref()))
            .collect();
        assert_eq!(
            shown,
            [
                ("Assistant", 7, Some("report.pdf")),
                ("Assistant", 3, Some("table.csv")),
                ("You", 1, Some("plan.txt")),
            ]
        );
        // The JSON the panel hands the file cards: hints only, never paths.
        let json = serde_json::to_string(&files).unwrap();
        assert!(json.contains("\"from\":\"You\"") && json.contains("\"kind\":\"encrypted\""));
        assert!(!json.contains("/synthetic/"), "{json}");
    }

    #[test]
    fn a_long_chat_lists_the_newest_files_only() {
        let texts: Vec<String> = (0..CHAT_FILES_MAX + 5)
            .map(|i| format!("[File attached in the Orkestr app, encrypted upload 00000000-0000-4000-8000-{i:012}: f{i}.txt (text/plain, 1 bytes), SHA-256 digest]"))
            .collect();
        let files = newest_first(
            texts
                .iter()
                .enumerate()
                .map(|(i, t)| (i as i64 + 1, "You".to_string(), t.as_str())),
        );
        assert_eq!(files.len(), CHAT_FILES_MAX);
        assert_eq!(files[0].sequence, (CHAT_FILES_MAX + 5) as i64);
        assert!(newest_first(std::iter::empty()).is_empty());
    }
}
