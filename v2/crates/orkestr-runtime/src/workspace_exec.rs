//! Explicit command boundary. The authenticated provider never receives these
//! mounts, environment, process permissions, or reusable workspace authority.
use crate::worker_sandbox::{
    WorkerCancellation, WorkerLimits, WorkerOutput, WorkerSandboxError as Error,
    WorkerSandboxResult as Result,
};
use orkestr_v2_store_sqlite::WorkspaceDescriptors;
use std::path::Path;

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod cgroup;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod linux;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod process;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod sandbox;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub use {process::WorkspaceExecProcess, sandbox::WorkspaceExecSandbox};

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub struct WorkspaceExecSandbox;
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub struct WorkspaceExecProcess;
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
impl WorkspaceExecSandbox {
    pub fn configured(_: &Path, _: &Path) -> Result<Self> {
        Err(Error::Unsupported)
    }
    pub fn start(
        &self,
        _: &str,
        _: WorkspaceDescriptors<'_>,
        _: WorkerLimits,
        _: &WorkerCancellation,
        _: Box<dyn Send>,
    ) -> Result<WorkspaceExecProcess> {
        Err(Error::Unsupported)
    }
}
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
impl WorkspaceExecProcess {
    pub fn wait(self, _: &WorkerCancellation) -> Result<WorkerOutput> {
        Err(Error::Unsupported)
    }
}
