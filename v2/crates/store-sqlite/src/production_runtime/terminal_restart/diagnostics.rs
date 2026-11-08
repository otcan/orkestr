//! Closed, non-authorizing restart observations. Emit only after SQL locks drop.
use super::*;
use std::{io::Write, time::Instant};

#[derive(Clone, Copy, Debug)]
pub(super) enum Phase {
    Request,
    WorkspacePreflight,
    BeginWriter,
    AuthenticateOwner,
    Supervisor,
    GracefulPredecessor,
    RetiredWindowPredecessor,
    Descendants,
    TerminalBinding,
    TakeoverRows,
    PhysicalHandoff,
    RebindWindow,
    RebindWorkspace,
    ReserveMetadata,
}

pub(super) struct Diagnostics {
    phase: Phase,
    started: Instant,
    elapsed: Vec<(Phase, u128)>,
}
impl Diagnostics {
    pub(super) fn new() -> Self {
        Self {
            phase: Phase::Request,
            started: Instant::now(),
            elapsed: Vec::with_capacity(14),
        }
    }
    pub(super) fn enter(&mut self, phase: Phase) {
        self.elapsed
            .push((self.phase, self.started.elapsed().as_micros()));
        self.phase = phase;
        self.started = Instant::now();
    }
    pub(super) fn emit<T>(&self, result: &Result<T>) {
        self.emit_to(result, &mut std::io::stderr().lock());
    }
    fn emit_to<T>(&self, result: &Result<T>, sink: &mut impl Write) {
        let Err(error) = result else { return };
        // RuntimeStoreError is a closed, payload-free enum. Never log SQL,
        // credentials, project paths, native IDs or request bodies here.
        let _ = writeln!(
            sink,
            "terminal_reattachment phase={:?} class={error:?} elapsed_us={}",
            self.phase,
            self.started.elapsed().as_micros()
        );
        for (phase, elapsed) in &self.elapsed {
            let _ = writeln!(
                sink,
                "terminal_reattachment completed_phase={phase:?} elapsed_us={elapsed}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
    }
    #[test]
    fn failed_diagnostic_sink_preserves_original_result() {
        let mut diagnostics = Diagnostics::new();
        diagnostics.enter(Phase::PhysicalHandoff);
        let result: Result<()> = Err(RuntimeStoreError::Fenced);
        diagnostics.emit_to(&result, &mut Broken);
        assert!(matches!(result, Err(RuntimeStoreError::Fenced)));
        let successful = Ok(17);
        let mut output = Vec::new();
        diagnostics.emit_to(&successful, &mut output);
        assert_eq!(successful, Ok(17));
        assert!(output.is_empty());
    }
}
