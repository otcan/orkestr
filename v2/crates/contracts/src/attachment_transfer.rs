//! Copy-only attachment transport. Byte arrays are raw octets, not base64.
use crate::AttachmentManifest;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
pub const ATTACHMENT_MAX_JSON_BYTES: usize = 68 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentContent {
    pub reference_id: Uuid,
    pub bytes: Vec<u8>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentBundle {
    pub manifest: AttachmentManifest,
    pub contents: Vec<AttachmentContent>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentReferenceMapping {
    pub source_reference_id: Uuid,
    pub target_reference_id: Uuid,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentImportRequest {
    pub request_key: String,
    pub source: AttachmentBundle,
    pub target_manifest: AttachmentManifest,
    pub mapping: Vec<AttachmentReferenceMapping>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentImportReceipt {
    pub import_id: Uuid,
    pub manifest: AttachmentManifest,
    pub source_manifest_id: Uuid,
    pub mapping: Vec<AttachmentReferenceMapping>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentRemovalReceipt {
    pub manifest_id: Uuid,
    pub reference_id: Uuid,
    pub removed: bool,
}

/// A sampled keyset page, not a cross-page snapshot or attachment authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentManifestPage {
    pub owner_id: crate::OwnerId,
    pub conversation_id: crate::ConversationId,
    pub after_id: Option<Uuid>,
    pub next_after_id: Option<Uuid>,
    pub manifests: Vec<AttachmentManifest>,
}
