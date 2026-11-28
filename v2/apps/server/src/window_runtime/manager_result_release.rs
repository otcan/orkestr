//! Release of a completed managed result to the caller still waiting on it.
//!
//! Core has already persisted the operation's outcome when this runs
//! (`complete_managed_operation`); the release only lets the manager hand that
//! result to its caller. It is written at most once (`with_managed_result_fence`)
//! and never replayed. It ends in one of three ways:
//!
//! - authorized: the manager serves the result to its caller;
//! - refused ([`ResultRefused`]): Core refused before the frame was written, or
//!   the manager answered `control_refused`. Every manager refusal comes before
//!   its single authorization write (`authorize_result`), so in both cases the
//!   manager never authorized the result: it cannot reach its caller;
//! - unknown (`ManagerError`): the frame may have been applied and the answer
//!   lost (deadline, unavailable peer, a Core commit that failed after the
//!   write, a malformed reply).
use super::*;
use orkestr_v2_store_sqlite::{CompletedManagedOperation, Store};
use std::sync::atomic::{AtomicBool, Ordering};

/// Who definitely refused a result release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResultRefused {
    /// Core refused before the frame was written: the workspace preflight or
    /// the result fence (for example a workspace handoff that expired while
    /// the release waited for Core's writer). The manager never saw it.
    Core,
    /// The manager answered `control_refused`, with its static refusal code
    /// (for example `managed_result_run_closed`) when it sends one.
    Manager { reason: Option<String> },
}

impl ResultRefused {
    /// Static code for the operator log; never request values.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Core => "core_refused",
            Self::Manager { .. } => "manager_refused",
        }
    }
    /// The manager's closed refusal code, if it sent one.
    pub(crate) fn reason(&self) -> Option<&str> {
        match self {
            Self::Core => None,
            Self::Manager { reason } => reason.as_deref(),
        }
    }
}

/// The manager's refusal answer, in the shapes `exchange` accepts: with or
/// without its static refusal code. A malformed code is dropped, never turned
/// into a protocol error; any other field is. Its `control_unavailable` answer
/// (an I/O error, possibly after a write) is not a refusal and stays a protocol
/// error here.
fn refused_reply(value: &Value) -> Option<ResultRefused> {
    if value.get("ok") != Some(&Value::Bool(false))
        || value.get("code").and_then(Value::as_str) != Some("control_refused")
    {
        return None;
    }
    let reason = if fields(value, &["ok", "code", "receipt"]) {
        None
    } else if fields(value, &["ok", "code", "receipt", "reason"]) {
        closed_code(&value["reason"])
    } else {
        return None;
    };
    Some(ResultRefused::Manager { reason })
}

/// A refusal code is a closed static token (the manager sends nothing else).
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

impl ManagerClient {
    pub(crate) async fn release_managed_result(
        &self,
        store: &Store,
        credential: &str,
        window: &Window,
        result: &CompletedManagedOperation,
        deadline: Instant,
    ) -> Result<std::result::Result<(), ResultRefused>> {
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let workspace = match tokio::time::timeout_at(
            deadline.into(),
            store.preflight_workspace(&self.owner, &self.conversation),
        )
        .await
        {
            Err(_) => return Err(ManagerError::Deadline),
            Ok(Err(_)) => return Ok(Err(ResultRefused::Core)),
            Ok(Ok(workspace)) => workspace,
        };
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let store = &*workspace;
        let mut request = self.request(
            "managed_result",
            &format!("managed-result:{}", result.id()),
            Some(window),
        )?;
        request["result"] = result.root_request();
        // A Core refusal after the frame was written (its commit failed) is
        // no proof that the manager never authorized the result: unknown.
        let written = AtomicBool::new(false);
        let core_refused = AtomicBool::new(false);
        let exchanged = self
            .managed_fenced_exchange(request, deadline, |stream, frame| {
                store
                    .with_managed_result_fence(credential, result, || {
                        if Instant::now() >= deadline {
                            return Err(ManagerError::Deadline);
                        }
                        self.parent()?;
                        let sent = stream
                            .try_write(frame)
                            .map_err(|_| ManagerError::Unavailable)?;
                        written.store(true, Ordering::SeqCst);
                        Ok(sent)
                    })
                    .map_err(|_| {
                        if written.load(Ordering::SeqCst) {
                            return ManagerError::Unavailable;
                        }
                        core_refused.store(true, Ordering::SeqCst);
                        ManagerError::Refused
                    })?
            })
            .await;
        let value = match exchanged {
            Err(_) if core_refused.load(Ordering::SeqCst) => return Ok(Err(ResultRefused::Core)),
            exchanged => exchanged?,
        };
        if let Some(refused) = refused_reply(&value) {
            self.receipt(&value["receipt"])?;
            return Ok(Err(refused));
        }
        success_fields(&value, Some("managed_result"))?;
        self.window_receipt(&value["receipt"], window)?;
        let expected = result.root_request();
        let observed = &value["managed_result"];
        if !fields(observed, &["operation_id", "run_id", "authorized"])
            || observed["operation_id"] != expected["operation_id"]
            || observed["run_id"] != expected["run_id"]
            || observed["authorized"] != true
        {
            return Err(ManagerError::Protocol);
        }
        Ok(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt() -> Value {
        json!({"owner_id": "o", "conversation_id": "c", "window_id": null,
               "generation": 0, "state": "idle"})
    }

    fn refused(reason: Option<&str>) -> Option<ResultRefused> {
        Some(ResultRefused::Manager {
            reason: reason.map(str::to_owned),
        })
    }

    #[test]
    fn a_managers_refusal_counts_with_or_without_its_code() {
        assert_eq!(
            refused_reply(&json!({"ok": false, "code": "control_refused", "receipt": receipt()})),
            refused(None)
        );
        assert_eq!(
            refused_reply(
                &json!({"ok": false, "code": "control_refused", "receipt": receipt(),
                                  "reason": "managed_result_run_closed"})
            ),
            refused(Some("managed_result_run_closed"))
        );
        // A malformed code is dropped; the refusal stays definite.
        for reason in [
            json!(""),
            json!("Managed_Result"),
            json!("managed-result"),
            json!("x".repeat(65)),
            json!(7),
            json!(null),
        ] {
            assert_eq!(
                refused_reply(&json!({"ok": false, "code": "control_refused",
                                      "receipt": receipt(), "reason": reason})),
                refused(None),
                "{reason}"
            );
        }
    }

    #[test]
    fn nothing_else_counts_as_the_managers_refusal() {
        for other in [
            // An I/O error at the manager may follow its authorization write.
            json!({"ok": false, "code": "control_unavailable"}),
            json!({"ok": false, "code": "control_unavailable", "receipt": receipt()}),
            json!({"ok": false, "code": "control_refused"}),
            json!({"ok": false, "code": "control_refused", "receipt": receipt(), "detail": "x"}),
            json!({"ok": false, "code": "control_refused", "receipt": receipt(),
                   "reason": "x", "detail": "x"}),
            json!({"ok": true, "code": "control_refused", "receipt": receipt()}),
            json!({"ok": true, "receipt": receipt(), "managed_result": {}}),
        ] {
            assert_eq!(refused_reply(&other), None, "{other}");
        }
    }

    #[test]
    fn refusal_codes_are_static_and_distinct() {
        assert_eq!(ResultRefused::Core.code(), "core_refused");
        assert_eq!(ResultRefused::Core.reason(), None);
        let manager = refused(Some("managed_result_scope")).unwrap();
        assert_eq!(manager.code(), "manager_refused");
        assert_eq!(manager.reason(), Some("managed_result_scope"));
    }
}
