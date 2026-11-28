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
/// Admission refusal codes about the request itself: the manager refuses this
/// exact admission again however long it waits, so waiting cannot help.
/// Every other code may clear by itself (`window_capacity`,
/// `package_inventory`, `manager_custody_fault`, a qualification hold, the
/// manager's clock in `window_deadlines`), names a record of this window
/// (`window_reused`), or is a malformed request; a refusal without a code
/// (an older manager) proves nothing either. Those keep the uncertain path:
/// failing the open at once would spend a timer firing's one retry on a
/// cause that may already have cleared.
const DEFINITE_CODES: [&str; 4] = [
    "input_reused",
    "idempotency_conflict",
    "window_generation",
    "window_predecessor",
];

impl RefusedAdmission {
    /// The manager holds nothing of this window (the refusal's receipt
    /// excludes it: no admission, budget or custody) and would refuse it
    /// again: its code names the request itself, never a passing condition.
    pub(crate) fn is_definite(&self) -> bool {
        self.refusal
            .reason
            .as_deref()
            .is_some_and(|code| DEFINITE_CODES.contains(&code))
            && self.refusal.receipt.never_admitted(&self.window)
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
