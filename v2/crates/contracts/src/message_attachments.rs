//! Files the owner attaches to a message from the web UI (Attach, Paste text).
//! A native conversation stores them in its attachment store and names them
//! in the message text with a local file the model can open; a linked V1 chat
//! uploads them to V1, which attaches them to the V1 message.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MESSAGE_ATTACHMENT_FILES_MAX: usize = 8;
/// Decoded bytes over all files of one upload (the attachment store limit).
pub const MESSAGE_ATTACHMENT_BYTES_MAX: usize = 16 * 1024 * 1024;
pub const MESSAGE_ATTACHMENT_NAME_MAX: usize = 255;

fn label(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn media_type(value: &str) -> bool {
    let mut parts = value.splitn(2, '/');
    let token = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
    };
    matches!((parts.next(), parts.next()), (Some(a), Some(b)) if token(a) && token(b))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageAttachmentFile {
    pub filename: String,
    pub media_type: String,
    /// Standard base64 of the file bytes.
    pub content_base64: String,
}

/// `POST /api/v2/conversations/{id}/message-attachments` and
/// `POST /api/v2/v1-threads/{thread}/uploads`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageAttachmentUpload {
    /// Client UUID; a replay with the same key stores nothing new.
    pub request_key: String,
    pub files: Vec<MessageAttachmentFile>,
}
impl MessageAttachmentUpload {
    pub fn is_valid(&self) -> bool {
        Uuid::parse_str(&self.request_key)
            .is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == self.request_key)
            && !self.files.is_empty()
            && self.files.len() <= MESSAGE_ATTACHMENT_FILES_MAX
            && self.files.iter().all(|f| {
                label(&f.filename, MESSAGE_ATTACHMENT_NAME_MAX)
                    && !f.filename.contains(['/', '\\'])
                    && media_type(&f.media_type)
                    && !f.content_base64.is_empty()
                    && f.content_base64.len() <= MESSAGE_ATTACHMENT_BYTES_MAX / 3 * 4 + 8
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageAttachmentSummary {
    /// Native: attachment reference id. V1: upload id to pass with the input.
    pub attachment_id: String,
    pub filename: String,
    pub media_type: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageAttachmentReceipt {
    /// Native conversations: the manifest holding the files.
    pub manifest_id: Option<Uuid>,
    pub attachments: Vec<MessageAttachmentSummary>,
    /// Native conversations: text to append to the message so the model
    /// knows the files and where to open them. Empty for V1 uploads.
    pub note: String,
}
impl MessageAttachmentReceipt {
    pub fn is_valid(&self) -> bool {
        !self.attachments.is_empty()
            && self.attachments.len() <= MESSAGE_ATTACHMENT_FILES_MAX
            && self.attachments.iter().all(|a| {
                label(&a.attachment_id, 64)
                    && label(&a.filename, MESSAGE_ATTACHMENT_NAME_MAX)
                    && media_type(&a.media_type)
            })
            && self.note.len() <= 16 * 1024
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn upload(name: &str, media: &str) -> MessageAttachmentUpload {
        MessageAttachmentUpload {
            request_key: "6a3f5c47-3c2d-4bd6-9d33-0c1a1e7f1b2a".into(),
            files: vec![MessageAttachmentFile {
                filename: name.into(),
                media_type: media.into(),
                content_base64: "aGk=".into(),
            }],
        }
    }
    #[test]
    fn uploads_are_bounded_named_and_typed() {
        assert!(upload("photo.png", "image/png").is_valid());
        assert!(upload("pasted text.txt", "text/plain").is_valid());
        assert!(!upload("../photo.png", "image/png").is_valid());
        assert!(!upload("photo.png", "image").is_valid());
        assert!(!upload("photo.png", "image/png; x=1").is_valid());
        let mut many = upload("a.png", "image/png");
        many.files = vec![many.files[0].clone(); MESSAGE_ATTACHMENT_FILES_MAX + 1];
        assert!(!many.is_valid());
        let mut key = upload("a.png", "image/png");
        key.request_key = "not-a-uuid".into();
        assert!(!key.is_valid());
    }
}
