//! Immutable attachment metadata. These values confer no read or import authority.
use crate::{ConversationId, MessageId, OwnerId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const ATTACHMENT_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub const ATTACHMENT_MAX_REFERENCES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentState {
    Available,
    Removed,
    /// Preserved legacy metadata only. Never a downloadable object.
    Inert,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentReference {
    pub reference_id: Uuid,
    pub message_id: Option<MessageId>,
    pub filename: String,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: String,
    pub state: AttachmentState,
}
impl AttachmentReference {
    pub fn is_valid(&self) -> bool {
        if self.state == AttachmentState::Inert {
            return !self.reference_id.is_nil()
                && self.message_id.as_ref().is_none_or(|id| !id.0.is_nil())
                && !self.filename.is_empty()
                && self.filename.len() <= 4096
                && self.media_type.len() <= 1024
                && self.sha256.len() <= 128
                && !self.filename.contains('\0')
                && !self.media_type.contains('\0')
                && !self.sha256.contains('\0');
        }
        let token = |s: &str| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
        };
        let media = self.media_type.split_once('/');
        !self.reference_id.is_nil()
            && self.message_id.as_ref().is_none_or(|id| !id.0.is_nil())
            && !self.filename.is_empty()
            && self.filename.len() <= 255
            && self.filename != "."
            && self.filename != ".."
            && !self
                .filename
                .chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
            && self.media_type.len() <= 127
            && media.is_some_and(|(a, b)| token(a) && token(b))
            && self.byte_length <= ATTACHMENT_MAX_BYTES
            && self.sha256.len() == 64
            && self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentManifest {
    pub schema_version: u32,
    pub manifest_id: Uuid,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub references: Vec<AttachmentReference>,
}
impl AttachmentManifest {
    pub fn is_valid(&self) -> bool {
        let mut ids = std::collections::HashSet::new();
        let mut total = 0u64;
        self.schema_version == 1
            && !self.manifest_id.is_nil()
            && !self.owner_id.0.is_nil()
            && !self.conversation_id.0.is_nil()
            && self.references.len() <= ATTACHMENT_MAX_REFERENCES
            && self.references.iter().all(|r| {
                if r.state != AttachmentState::Inert {
                    total = total.saturating_add(r.byte_length);
                }
                r.is_valid() && ids.insert(r.reference_id) && total <= ATTACHMENT_MAX_BYTES
            })
    }
}
