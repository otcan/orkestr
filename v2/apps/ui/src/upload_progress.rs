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
    }
    pub fn percent(&self) -> u64 {
        if self.total_bytes == 0 {
            0
        } else {
            self.completed_bytes.saturating_mul(100) / self.total_bytes
        }
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
