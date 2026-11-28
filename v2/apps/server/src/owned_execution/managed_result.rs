//! What a managed result release that did not go through means for its run.
//!
//! By the time a result is released, Core has already persisted the
//! operation's outcome and the Deep run's managed slot is free again. Any
//! release error used to pause the whole window ("release unknown; replay
//! refused"); the automatic reconciliation then abandoned the window and the
//! owner's turn was lost. On 2026-11-27 a Root-request result was refused
//! inside Core (workspace preflight or result fence) before anything was sent;
//! the manager's record shows no authorization. The pause then reaped the
//! run, and with it the caller that was still waiting for that result.
//!
//! A definite refusal ([`ResultRefused`]) means the manager never authorized
//! the result, so nothing can be replayed or applied twice. Only that one
//! delivery fails and the run continues:
//!
//! - The Deep loop goes on polling `managed_pending` for the next managed
//!   call. The refused claim is already terminal at the manager (`completed`),
//!   so it is never listed or consumed again.
//! - The agent's tool call is answered by the manager, never by a replay:
//!   with outcome `unknown` at the caller's own deadline
//!   (`managed_call_deadline`, at most about five minutes after the
//!   consumption), or `cancelled` (`source_run_closed`) if the run's managed
//!   scope closes first (Stop, work deadline). The agent then carries on with
//!   its turn, as after any other unknown managed outcome; the request itself
//!   stays applied exactly once.
//!
//! An unknown release (deadline, unavailable peer, malformed answer, a Core
//! commit that failed after the frame was written) still pauses the window:
//! the manager may have authorized it.
use crate::window_runtime::manager_client::{ManagerError, ResultRefused};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Released {
    /// The manager authorized the result for its caller.
    Authorized,
    /// Definitely not authorized: only this delivery fails.
    Undeliverable(ResultRefused),
}

pub(super) fn released(
    release: Result<Result<(), ResultRefused>, ManagerError>,
) -> Result<Released, &'static str> {
    match release {
        Ok(Ok(())) => Ok(Released::Authorized),
        Ok(Err(refused)) => Ok(Released::Undeliverable(refused)),
        Err(_) => Err("managed result release unknown; replay refused"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_definite_refusal_fails_only_that_delivery() {
        assert_eq!(released(Ok(Ok(()))), Ok(Released::Authorized));
        // 2026-11-27: Core's result fence refused before the frame was sent.
        for refused in [
            ResultRefused::Core,
            ResultRefused::Manager { reason: None },
            ResultRefused::Manager {
                reason: Some("managed_result_run_closed".into()),
            },
        ] {
            assert_eq!(
                released(Ok(Err(refused.clone()))),
                Ok(Released::Undeliverable(refused))
            );
        }
    }

    #[test]
    fn an_unknown_release_still_pauses_the_window() {
        for error in [
            ManagerError::InvalidRequest,
            ManagerError::Peer,
            ManagerError::Deadline,
            ManagerError::Unavailable,
            ManagerError::Protocol,
            // Never produced by a release any more (a refusal is
            // `ResultRefused`), and still not proof of non-delivery.
            ManagerError::Refused,
        ] {
            assert_eq!(
                released(Err(error)),
                Err("managed result release unknown; replay refused")
            );
        }
    }
}
