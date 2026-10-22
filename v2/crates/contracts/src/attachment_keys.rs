//! Browser recipients for attachment encryption (age X25519, V1 protocol).
//!
//! A browser keeps its age identity; only the public `age1...` recipient is
//! registered. It becomes active after the browser decrypts a short-lived
//! possession challenge and returns the proof. Stored attachment objects are
//! ciphertext for the active recipients; downloads return that ciphertext.
use crate::{AttachmentManifest, OwnerId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentRecipientRegistration {
    pub recipient: String,
    #[serde(default)]
    pub label: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentRecipientProof {
    pub proof: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentRecipientRevocation {
    #[serde(default)]
    pub reason: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentEncryptionPolicyUpdate {
    pub required: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentRecipientStatus {
    PendingVerification,
    Active,
    Revoked,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentRecipientOrigin {
    /// Possession proven to this server.
    Enrolled,
    /// Possession proven to the V1 app; imported by the operator.
    V1Import,
}
/// The age ciphertext (base64) of the proof the browser must return.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentRecipientChallenge {
    pub id: Uuid,
    pub ciphertext_base64: String,
    pub expires_at: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentRecipientRecord {
    pub id: Uuid,
    pub label: String,
    pub recipient: String,
    pub fingerprint: String,
    pub status: AttachmentRecipientStatus,
    pub origin: AttachmentRecipientOrigin,
    pub created_at: i64,
    pub verified_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub revoked_reason: Option<String>,
    pub challenge: Option<AttachmentRecipientChallenge>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentEncryptionStatus {
    pub owner_id: OwnerId,
    /// New objects are refused while no recipient is active.
    pub required: bool,
    /// At least one recipient is active.
    pub ready: bool,
    pub keys: Vec<AttachmentRecipientRecord>,
    /// Stored objects that are still plaintext (doctor check; 0 when sealed).
    pub plaintext_objects: u64,
    pub sealed_objects: u64,
}

/// How one stored object is represented in an export.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StoredAttachmentFormat {
    /// Legacy object stored before any recipient existed.
    Plain,
    /// age file for `recipient_fingerprints`; plaintext is the V1 payload.
    AgeX25519V1,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredAttachmentContent {
    pub reference_id: Uuid,
    pub format: StoredAttachmentFormat,
    pub bytes: Vec<u8>,
    pub recipient_fingerprints: Vec<String>,
}
/// Export of one manifest as stored: the browser decrypts sealed contents.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredAttachmentBundle {
    pub manifest: AttachmentManifest,
    pub contents: Vec<StoredAttachmentContent>,
}
