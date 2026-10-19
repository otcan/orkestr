//! Opt-in OS boundary for untrusted single-process Python work, not provider auth.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerSandboxError {
    Unsupported,
    InvalidConfig,
    InvalidInput,
    Busy,
    Io,
    Timeout,
    OutputLimit,
    Cancelled,
}
pub type WorkerSandboxResult<T> = Result<T, WorkerSandboxError>;

#[derive(Clone, Default)]
pub struct WorkerCancellation(Arc<AtomicBool>);
impl WorkerCancellation {
    /// Trusted control only; a caller must persist its required cancellation first.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    fn cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct WorkerLimits {
    pub timeout: Duration,
    pub max_output_bytes: usize,
}
impl Default for WorkerLimits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(5),
            max_output_bytes: 128 * 1024,
        }
    }
}

/// Bounded untrusted bytes. Neither exit zero nor output is a task-acceptance grant.
pub struct WorkerOutput {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[path = "worker_sandbox/implementation.rs"]
mod implementation;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub use implementation::{WorkerProcess, WorkerSandbox};

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub struct WorkerSandbox(());
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub struct WorkerProcess(());
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
impl WorkerSandbox {
    pub fn opt_in_python_offline() -> WorkerSandboxResult<Self> {
        Err(WorkerSandboxError::Unsupported)
    }
    pub fn run_python(
        &self,
        _: &str,
        _: WorkerLimits,
        cancellation: &WorkerCancellation,
    ) -> WorkerSandboxResult<WorkerOutput> {
        let _ = cancellation.cancelled();
        Err(WorkerSandboxError::Unsupported)
    }
    pub fn start_python(
        &self,
        _: &str,
        _: WorkerLimits,
        cancellation: &WorkerCancellation,
    ) -> WorkerSandboxResult<WorkerProcess> {
        let _ = cancellation.cancelled();
        Err(WorkerSandboxError::Unsupported)
    }
}
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
impl WorkerProcess {
    pub fn wait(self, cancellation: &WorkerCancellation) -> WorkerSandboxResult<WorkerOutput> {
        let _ = cancellation.cancelled();
        Err(WorkerSandboxError::Unsupported)
    }
}
