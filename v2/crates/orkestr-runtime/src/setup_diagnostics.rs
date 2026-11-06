//! Closed, value-free diagnostics; never authority or a retry decision.
use std::{
    io::Write,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    Launcher,
    CapabilityEnable,
    ManagerBind,
    MetadataOpen,
    MetadataFence,
    MetadataEnqueue,
}

pub(crate) trait FailureCode {
    fn failure_code(&self) -> &'static str;
}

pub(crate) fn measure<T, E: FailureCode>(
    stage: Stage,
    role: orkestr_v2_application::runtime::Role,
    action: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let started = Instant::now();
    let result = action();
    let outcome = result
        .as_ref()
        .err()
        .map_or("ok", FailureCode::failure_code);
    record(stage, role, started.elapsed(), outcome);
    result
}

pub(crate) fn record(
    stage: Stage,
    role: orkestr_v2_application::runtime::Role,
    elapsed: Duration,
    outcome: &'static str,
) {
    #[cfg(test)]
    EVENTS.with(|events| events.borrow_mut().push((stage, outcome)));
    let _ = writeln!(
        std::io::stderr().lock(),
        "owned_setup stage={stage:?} role={role:?} outcome={outcome} elapsed_us={}",
        elapsed.as_micros()
    );
}

impl FailureCode for crate::containment::Error {
    fn failure_code(&self) -> &'static str {
        use crate::containment::Error::*;
        match self {
            InvalidScope => "invalid_scope",
            WrongScope => "wrong_scope",
            Revoked => "revoked",
            AuthorityProtocol => "authority_protocol",
            Unsupported => "unsupported",
            InvalidPath => "invalid_path",
            InvalidBounds => "invalid_bounds",
            InvalidFrame => "invalid_frame",
            FrameTooLarge => "frame_too_large",
            Backpressure => "backpressure",
            Capacity => "capacity",
            PipeClosed => "pipe_closed",
            TruncatedFrame => "truncated_frame",
            Io => "io",
        }
    }
}

#[cfg(test)]
thread_local! {
    static EVENTS: std::cell::RefCell<Vec<(Stage, &'static str)>> = const { std::cell::RefCell::new(Vec::new()) };
}
#[cfg(test)]
pub(crate) fn take_events() -> Vec<(Stage, &'static str)> {
    EVENTS.with(|events| std::mem::take(&mut *events.borrow_mut()))
}
