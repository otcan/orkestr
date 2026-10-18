//! Owner-authenticated, CSRF-protected control inputs. Not executable authority.
//! Endpoints must reject unavailable controls without fabricating a receipt.
use crate::RunId;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionControlRequest {
    pub run_id: RunId,
    /// Conversation snapshot revision, never the run's lease generation/version.
    pub expected_revision: i64,
    /// Exact run control revision from status. Legacy None retains strict
    /// conversation-revision CAS; supplied value never authorizes another run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_control_revision: Option<i64>,
    pub request_key: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionSteerRequest {
    pub run_id: RunId,
    pub expected_revision: i64,
    pub request_key: String,
    pub text: String,
}
fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 128 && !key.chars().any(char::is_control)
}
impl ExecutionControlRequest {
    pub fn is_valid(&self) -> bool {
        !self.run_id.0.is_nil() && self.expected_revision >= 0 && self.expected_control_revision.is_none_or(|r| r > 0) && valid_key(&self.request_key)
    }
}
impl ExecutionSteerRequest {
    pub fn is_valid(&self) -> bool {
        !self.run_id.0.is_nil()
            && self.expected_revision >= 0
            && valid_key(&self.request_key)
            && !self.text.trim().is_empty()
            && self.text.len() <= 16_384
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_controls_cannot_pass_structural_validation() {
        let mut input = ExecutionSteerRequest {
            run_id: RunId(uuid::Uuid::from_u128(1)),
            expected_revision: 0,
            request_key: "retry:1".into(),
            text: "input".into(),
        };
        assert!(input.is_valid());
        input.expected_revision = -1;
        assert!(!input.is_valid());
        input.expected_revision = 0;
        input.request_key = "bad\nkey".into();
        assert!(!input.is_valid());
        input.request_key = "retry:1".into();
        input.text = "x".repeat(16_385);
        assert!(!input.is_valid());
    }
}
