//! Presentation of acknowledged plaintext bytes, never speculative wire progress.
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadPhase {
    Preparing,
    Checking,
    Encrypting,
    Uploading,
    Finalizing,
    PreparingAttachment,
    FileReady,
    Ready,
    Failed,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UploadProgress {
    pub phase: UploadPhase,
    /// The encrypted upload this file is sent as; its Cancel names it.
    #[serde(default)]
    pub upload_id: Option<String>,
    pub file_name: String,
    pub file_index: u8,
    pub file_count: u8,
    pub completed_bytes: u64,
    pub total_bytes: u64,
}
impl UploadProgress {
    pub fn is_valid(&self) -> bool {
        (1..=8).contains(&self.file_count)
            && self.file_index >= 1
            && self.file_index <= self.file_count
            && !self.file_name.is_empty()
            && self.file_name.len() <= 255
            && !self.file_name.chars().any(char::is_control)
            && self.total_bytes > 0
            && self.total_bytes <= 8_000_000_000
            && self.completed_bytes <= self.total_bytes
            && (self.phase != UploadPhase::Ready || self.completed_bytes == self.total_bytes)
            && self.upload_id.as_deref().is_none_or(is_upload_id)
    }
    /// The upload a Cancel control may stop: one still transferring or being
    /// prepared. A finished file is removed from its chip instead.
    pub fn cancellable(&self) -> Option<&str> {
        use UploadPhase::*;
        match self.phase {
            Preparing | Checking | Encrypting | Uploading | Finalizing | PreparingAttachment => {
                self.upload_id.as_deref()
            }
            FileReady | Ready | Failed => None,
        }
    }
    pub fn percent(&self) -> u64 {
        self.completed_bytes
            .saturating_mul(100)
            .checked_div(self.total_bytes)
            .unwrap_or(0)
    }
    pub fn label(&self) -> &'static str {
        match self.phase {
            UploadPhase::Preparing => "Preparing upload",
            UploadPhase::Checking => "Checking previously uploaded data",
            UploadPhase::Encrypting => "Encrypting file",
            UploadPhase::Uploading => "Uploading encrypted file",
            UploadPhase::Finalizing => "Finishing encrypted transfer",
            UploadPhase::PreparingAttachment => "File transferred — preparing attachment",
            UploadPhase::FileReady => "File attached",
            UploadPhase::Ready => "Attachment ready",
            UploadPhase::Failed => "Upload interrupted — reselect the file to resume",
        }
    }
    pub fn is_active(&self) -> bool {
        self.phase != UploadPhase::Failed
    }
}
/// A lowercase, non-nil UUID, as the browser uploader generates.
pub fn is_upload_id(value: &str) -> bool {
    value.len() == 36
        && value != "00000000-0000-0000-0000-000000000000"
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}
