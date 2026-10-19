use crate::Error;
use axum::{
    extract::rejection::JsonRejection,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use orkestr_v2_contracts::{MemoryOperation, MemoryOwnerDecision, MemoryProposal, MemoryRecord};
use orkestr_v2_store_sqlite::memory::MemoryError;
use serde::{Deserialize, Serialize};
pub(super) const REQUEST_MAX: usize = 64 * 1024;
pub(super) const QUERY_MAX: usize = 4 * 1024 * 1024;
pub(super) const EXPORT_MAX: usize = 8 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Selection {
    pub enabled: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Propose {
    pub request_key: String,
    pub operation: MemoryOperation,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Decision {
    pub proposal: MemoryProposal,
    pub decision: MemoryOwnerDecision,
}
#[derive(Serialize)]
pub(super) struct Records {
    pub records: Vec<MemoryRecord>,
}
pub(super) fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "memory_invalid",
        "Invalid Memory request",
    )
}
pub(super) fn unauthorized() -> Error {
    Error(
        StatusCode::UNAUTHORIZED,
        "memory_unauthorized",
        "Memory authentication required",
    )
}
pub(super) fn error(error: MemoryError) -> Error {
    let (status, code) = match error {
        MemoryError::Invalid => (StatusCode::BAD_REQUEST, "memory_invalid"),
        MemoryError::Unauthorized => return unauthorized(),
        MemoryError::Disabled => (StatusCode::CONFLICT, "memory_disabled"),
        MemoryError::NotFound => (StatusCode::NOT_FOUND, "memory_not_found"),
        MemoryError::Conflict => (StatusCode::CONFLICT, "memory_conflict"),
        MemoryError::Limit => (StatusCode::UNPROCESSABLE_ENTITY, "memory_limit"),
        MemoryError::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "memory_unavailable"),
    };
    Error(status, code, "Memory operation refused")
}
pub(super) fn json<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    body.map(|Json(value)| value).map_err(|e| {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "memory_body_too_large",
                "Memory request exceeds limit",
            )
        } else {
            invalid()
        }
    })
}
/// Serialize completely before headers/body publication. No prefix or truncation.
pub(super) fn response(value: &impl Serialize, max: usize) -> Result<Response, Error> {
    // A bounded writer prevents a large export from allocating an unbounded JSON buffer.
    struct Bound {
        bytes: Vec<u8>,
        max: usize,
        exceeded: bool,
    }
    impl std::io::Write for Bound {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.max.saturating_sub(self.bytes.len()) {
                self.exceeded = true;
                return Err(std::io::Error::other("response bound"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Bound {
        bytes: Vec::new(),
        max,
        exceeded: false,
    };
    if serde_json::to_writer(&mut writer, value).is_err() {
        return Err(error(if writer.exceeded {
            MemoryError::Limit
        } else {
            MemoryError::Unavailable
        }));
    }
    Ok(([(header::CONTENT_TYPE, "application/json")], writer.bytes).into_response())
}
