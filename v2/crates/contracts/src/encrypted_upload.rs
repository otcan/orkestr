//! Resumable browser-encrypted transport. Storage never admits a message;
//! a separate service-readable ingest step issues a provider-file receipt.
//! Each independently age-sealed
//! chunk binds the upload, owner, conversation and index inside its plaintext.
use crate::{ConversationId, OwnerId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const ENCRYPTED_UPLOAD_MAX_BYTES: u64 = 1_000_000_000;
pub const ENCRYPTED_UPLOAD_CHUNK_BYTES: u64 = 1024 * 1024;
pub const ENCRYPTED_UPLOAD_CIPHERTEXT_MAX: usize = 1024 * 1024 + 64 * 1024;
pub const ENCRYPTED_UPLOAD_FORMAT: &str = "age-x25519-chunks-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EncryptedUploadStart {
    pub upload_id: Uuid,
    pub filename: String,
    pub media_type: String,
    pub plaintext_size: u64,
}
impl EncryptedUploadStart {
    pub fn is_valid(&self) -> bool {
        !self.upload_id.is_nil()
            && (1..=ENCRYPTED_UPLOAD_MAX_BYTES).contains(&self.plaintext_size)
            && !self.filename.trim().is_empty()
            && self.filename.len() <= 255
            && !self.filename.contains(['/', '\\'])
            && !self.filename.chars().any(char::is_control)
            && self.media_type.len() <= 201
            && self.media_type.split('/').count() == 2
            && self.media_type.split('/').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
            })
    }
    pub fn chunk_count(&self) -> u64 {
        self.plaintext_size.div_ceil(ENCRYPTED_UPLOAD_CHUNK_BYTES)
    }
    pub fn chunk_size(&self, index: u64) -> Option<u64> {
        (index < self.chunk_count()).then(|| {
            (self.plaintext_size - index * ENCRYPTED_UPLOAD_CHUNK_BYTES)
                .min(ENCRYPTED_UPLOAD_CHUNK_BYTES)
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedUploadChunk {
    pub index: u64,
    pub ciphertext_size: u64,
    pub ciphertext_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedUploadStatus {
    pub format: String,
    pub file: EncryptedUploadStart,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    /// Immutable public recipient snapshot; private keys never reach Core.
    pub recipients: Vec<String>,
    /// Optional service ingest recipient: files submitted to the assistant are
    /// server-readable, matching native message-attachment semantics.
    pub ingest_recipient: Option<String>,
    pub chunk_bytes: u64,
    pub chunks: Vec<EncryptedUploadChunk>,
    pub complete: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decimal_limit_and_final_chunk_are_exact_without_allocating_file_bytes() {
        let mut file = EncryptedUploadStart {
            upload_id: Uuid::new_v4(),
            filename: "file.bin".into(),
            media_type: "application/octet-stream".into(),
            plaintext_size: ENCRYPTED_UPLOAD_MAX_BYTES,
        };
        assert!(file.is_valid());
        assert_eq!(file.chunk_count(), 954);
        assert_eq!(file.chunk_size(953), Some(707_072));
        assert_eq!(file.chunk_size(954), None);
        file.plaintext_size += 1;
        assert!(!file.is_valid());
        file.plaintext_size = 0;
        assert!(!file.is_valid());
    }
}
