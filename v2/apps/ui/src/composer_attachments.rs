//! Files attached in a composer before sending. A native message carries
//! the server's note (file names, local paths) in its text; a V1 message
//! carries the upload ids. Pure helpers; uploads happen in the component.
use orkestr_v2_contracts::{MessageAttachmentReceipt, MessageAttachmentSummary};

#[derive(Clone, Debug, PartialEq)]
pub struct Attached {
    pub summary: MessageAttachmentSummary,
    /// The upload's note, kept on its first file only.
    pub note: String,
}

pub fn from_receipt(receipt: MessageAttachmentReceipt) -> Vec<Attached> {
    receipt
        .attachments
        .into_iter()
        .enumerate()
        .map(|(i, summary)| Attached {
            summary,
            note: if i == 0 {
                receipt.note.clone()
            } else {
                String::new()
            },
        })
        .collect()
}

/// Message text for a native conversation: the typed text, then the notes.
pub fn native_text(typed: &str, attached: &[Attached]) -> String {
    let notes: Vec<&str> = attached
        .iter()
        .map(|a| a.note.as_str())
        .filter(|n| !n.is_empty())
        .collect();
    match (typed.trim().is_empty(), notes.is_empty()) {
        (_, true) => typed.to_owned(),
        (true, false) => notes.join("\n\n"),
        (false, false) => format!("{}\n\n{}", typed.trim_end(), notes.join("\n\n")),
    }
}

/// Text for a V1 message that has files but no typed text.
pub fn v1_text(typed: &str, attached: &[Attached]) -> String {
    if !typed.trim().is_empty() || attached.is_empty() {
        return typed.to_owned();
    }
    let names: Vec<&str> = attached
        .iter()
        .map(|a| a.summary.filename.as_str())
        .collect();
    format!("Attached: {}", names.join(", "))
}

pub fn ids(attached: &[Attached]) -> Vec<String> {
    attached
        .iter()
        .map(|a| a.summary.attachment_id.clone())
        .collect()
}

/// `12 KB`, `1.4 MB`.
pub fn size(bytes: u64) -> String {
    match bytes {
        0..1_000 => format!("{bytes} B"),
        1_000..1_000_000 => format!("{} KB", bytes.div_ceil(1_000)),
        _ => format!("{:.1} MB", bytes as f64 / 1e6),
    }
}
