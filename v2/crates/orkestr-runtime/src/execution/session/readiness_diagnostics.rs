//! Failed setup stage only; no provider frames, identities or account text.
use super::{Phase, SetupFailure};
use crate::setup_diagnostics::FailureCode;
use orkestr_v2_application::runtime::Role;
use std::io::Write;

pub(super) fn refused(phase: Phase, role: Role, error: &SetupFailure) {
    let phase = match phase {
        Phase::Open => "open",
        Phase::Initialize => "initialize",
        Phase::Initialized => "initialized",
        Phase::Account => "account",
        Phase::Thread => "thread",
        Phase::Ready => "ready",
    };
    let _ = writeln!(
        std::io::stderr().lock(),
        "owned_readiness phase={phase} role={role:?} outcome={}",
        error.failure_code()
    );
}
