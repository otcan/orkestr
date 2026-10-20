//! Explicit command boundary. The authenticated provider never receives these
//! mounts, environment, process permissions, or reusable workspace authority.
use crate::worker_sandbox::{
    WorkerCancellation, WorkerLimits, WorkerOutput, WorkerSandboxError as Error,
    WorkerSandboxResult as Result,
};
use orkestr_v2_store_sqlite::WorkspaceDescriptors;
use std::path::Path;

pub mod capture;
pub mod profile;

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod cgroup;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod layout;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod linux;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod process;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod sandbox;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub use {
    process::WorkspaceExecProcess,
    sandbox::{CommandKind, WorkspaceExecSandbox},
};

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub struct WorkspaceExecSandbox;
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub struct WorkspaceExecProcess;
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Command,
    Job,
}
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
impl WorkspaceExecSandbox {
    pub fn configured(_: &Path, _: &Path) -> Result<Self> {
        Err(Error::Unsupported)
    }
    pub fn configured_trusted(_: &Path, _: &Path, _: profile::TrustedProfile) -> Result<Self> {
        Err(Error::Unsupported)
    }
    pub fn trusted(&self) -> Option<&profile::TrustedProfile> {
        None
    }
    pub fn limits(&self, _: CommandKind) -> Option<WorkerLimits> {
        None
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
    pub fn start_job(
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
    pub fn wait_truncated(self, _: &WorkerCancellation) -> Result<WorkerOutput> {
        Err(Error::Unsupported)
    }
    pub fn wait_streaming(
        self,
        _: &WorkerCancellation,
        _: &mut dyn FnMut(bool, &[u8]),
    ) -> Result<(Option<i32>, Option<i32>)> {
        Err(Error::Unsupported)
    }
}
