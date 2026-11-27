//! A refused manager admission keeps the manager's own evidence.
//!
//! `control_refused` carries the conversation's latest manager window, read
//! after the refusal, and (from a manager that sends it) the static refusal
//! code. Only such a receipt can prove that the manager never admitted a
//! window. A missed deadline, an unavailable manager or a protocol error
//! proves nothing: the admission stays uncertain.
use super::*;

/// A `control_refused` answer.
#[derive(Debug, Clone)]
pub(crate) struct Refusal {
    /// The conversation's latest manager window after the refusal.
    pub receipt: ManagerReceipt,
    /// Static refusal code (for example `input_reused`). Diagnostic only:
    /// never authority, and absent from a manager that does not send it.
    pub reason: Option<String>,
}

/// One answer to a control request.
pub(super) enum Answer {
    Accepted(Value, Vec<u8>),
    Refused(Refusal),
}

/// What one admission request produced.
#[derive(Debug)]
pub(crate) enum AdmitOutcome {
    Admitted(Box<AdmissionAck>),
    Refused(Refusal),
}

/// The manager refused the admission of this exact window.
#[derive(Debug, Clone)]
pub(crate) struct RefusedAdmission {
    pub window: Window,
    pub refusal: Refusal,
}
impl RefusedAdmission {
    /// The refusal's receipt excludes this window: the manager holds nothing
    /// of it (no admission, budget or custody).
    pub(crate) fn proves_unadmitted(&self) -> bool {
        self.refusal.receipt.never_admitted(&self.window)
    }
}

impl ManagerReceipt {
    /// This receipt, the manager's latest window for the conversation, proves
    /// that the manager never admitted `window`: it has no window for the
    /// conversation, or its latest one is an earlier, retired window.
    pub(crate) fn never_admitted(&self, window: &Window) -> bool {
        match self {
            Self::Idle { .. } => true,
            Self::Window(r) => {
                r.window_id != window.window_id
                    && r.generation < window.generation
                    && r.state == WindowState::Retired
            }
        }
    }
}

impl ManagerClient {
    /// A failure answer (`ok` is false). `Ok(None)` is `control_unavailable`,
    /// which names no window. Any other shape is a protocol error.
    pub(super) fn refusal(&self, value: &Value) -> Result<Option<Refusal>> {
        let reason = match value.get("code").and_then(Value::as_str) {
            Some("control_refused") if fields(value, &["ok", "code", "receipt"]) => None,
            Some("control_refused") if fields(value, &["ok", "code", "receipt", "reason"]) => {
                closed_code(&value["reason"])
            }
            Some("control_unavailable") if fields(value, &["ok", "code"]) => return Ok(None),
            _ => return Err(ManagerError::Protocol),
        };
        Ok(Some(Refusal {
            receipt: self.receipt(&value["receipt"])?,
            reason,
        }))
    }
}

/// A refusal code is a closed static token. Anything else is dropped rather
/// than refused: a diagnostic never turns a refusal into a protocol error.
fn closed_code(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|code| {
            !code.is_empty()
                && code.len() <= 64
                && code
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        })
        .map(str::to_owned)
}

#[cfg(test)]
#[path = "manager_admission_tests.rs"]
mod tests;
