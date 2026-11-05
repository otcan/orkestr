//! Core command observer. Root alone owns spawning and physical cleanup.
use super::*;
use crate::window_runtime::{
    context::Context,
    manager_client::{RootCommand, RootCommandReceipt},
};
use orkestr_runtime::workspace_exec::capture::Capture;
use std::{fs::File, io::Read};

pub(super) struct Managed {
    pub context: Arc<Context>,
    pub command_output: usize,
    pub job_output: usize,
    pub job_timeout: Duration,
    pub max_jobs: usize,
}

struct Observer {
    command: RootCommand,
    manager: crate::window_runtime::manager_client::ManagerClient,
    window: crate::window_runtime::manager_client::Window,
    cap: Arc<ConsumedWorkspaceExec>,
    runtime: tokio::runtime::Handle,
}

impl Observer {
    fn drain(file: &mut File, consume: &mut dyn FnMut(&[u8])) -> Result<bool, WorkerSandboxError> {
        let mut bytes = [0; 8192];
        for _ in 0..8 {
            match file.read(&mut bytes) {
                Ok(0) => return Ok(true),
                Ok(count) => consume(&bytes[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(WorkerSandboxError::Io),
            }
        }
        Ok(false)
    }

    fn nonblocking(&self) -> Result<(), &'static str> {
        use rustix::fs::{fcntl_getfl, fcntl_setfl, OFlags};
        for file in [&self.command.stdout, &self.command.stderr] {
            let flags = fcntl_getfl(file).map_err(|_| "managed workspace output flags")?;
            fcntl_setfl(file, flags | OFlags::NONBLOCK)
                .map_err(|_| "managed workspace output flags")?;
        }
        Ok(())
    }

    /// Unknown cleanup never releases retained command accounting. Negative
    /// cancellation is idempotent; no query or transport failure restarts work.
    fn wait(
        &mut self,
        cancel: &WorkerCancellation,
        mut consume: impl FnMut(bool, &[u8]),
    ) -> Result<RootCommandReceipt, WorkerSandboxError> {
        let mut output_error = false;
        loop {
            if cancel.is_cancelled() || output_error {
                self.command.cancel();
            }
            let out = Self::drain(&mut self.command.stdout, &mut |b| consume(false, b));
            let err = Self::drain(&mut self.command.stderr, &mut |b| consume(true, b));
            output_error |= out.is_err() || err.is_err();
            let receipt = self.runtime.block_on(self.manager.query_workspace_command(
                &self.window,
                &self.cap,
                cancel.is_cancelled() || output_error,
            ));
            if let Ok(receipt) = receipt {
                if receipt.cleanup && (output_error || out == Ok(true) && err == Ok(true)) {
                    if output_error || receipt.state == "unknown" {
                        return Err(WorkerSandboxError::Io);
                    }
                    return Ok(receipt);
                }
            } else {
                self.command.cancel();
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

fn status(receipt: &RootCommandReceipt) -> Result<(Option<i32>, Option<i32>), WorkerSandboxError> {
    if receipt.cancellation.as_deref() == Some("deadline") {
        return Err(WorkerSandboxError::Timeout);
    }
    if receipt.cancelled {
        return Err(WorkerSandboxError::Cancelled);
    }
    match receipt.exit_code {
        Some(code) if (0..=255).contains(&code) => Ok((Some(code), None)),
        Some(code) if (-64..0).contains(&code) => Ok((None, Some(-code))),
        _ => Err(WorkerSandboxError::Io),
    }
}

fn captured(stdout: Capture, stderr: Capture, budget: usize) -> (Vec<u8>, Vec<u8>) {
    let mut stdout = stdout.finish();
    let mut stderr = stderr.finish();
    if stdout.len().saturating_add(stderr.len()) > budget {
        stdout.truncate(budget / 2);
        stderr.truncate(budget.saturating_sub(stdout.len()));
    }
    (stdout, stderr)
}

impl WorkspaceExecDispatcher {
    pub(crate) fn configured_managed(
        store: Store,
        credential: String,
        profile: Arc<WorkspaceExecProfile>,
        trusted: &crate::beta_config::workspace_exec_trusted::TrustedConfig,
        context: Arc<Context>,
        jobs_directory: &std::path::Path,
    ) -> Result<Self, &'static str> {
        trusted.validate_managed_runtime()?;
        let maximum = trusted.max_jobs.unwrap_or(1) as usize;
        Ok(Self {
            store,
            credential: credential.into(),
            profile,
            sandbox: None,
            jobs: (maximum > 0)
                .then(|| Jobs::for_directory(jobs_directory))
                .transpose()?,
            worker_run_ms: Some(trusted.worker_run_ms()),
            managed: Some(Managed {
                context,
                max_jobs: maximum,
                command_output: trusted.command_output_bytes.unwrap_or(128 * 1024) as usize,
                job_output: trusted.job_output_bytes.unwrap_or(4 * 1024 * 1024) as usize,
                job_timeout: Duration::from_millis(
                    trusted.job_timeout_ms.unwrap_or(1_800_000).into(),
                ),
            }),
        })
    }
    pub(super) async fn managed_command(
        &self,
        managed: &Managed,
        cap: Arc<ConsumedWorkspaceExec>,
        permit: tokio::sync::OwnedSemaphorePermit,
        retained: Box<dyn Send + 'static>,
        background: Option<String>,
    ) -> Result<WorkspaceExecOutput, &'static str> {
        if background.is_some()
            && (self.jobs.is_none()
                || self
                    .jobs
                    .as_ref()
                    .is_some_and(|jobs| jobs.running() >= managed.max_jobs))
        {
            return Ok(render::started(
                &Started::Busy(managed.max_jobs),
                managed.job_timeout,
            ));
        }
        let command = managed
            .context
            .manager
            .prepare_workspace_command(&managed.context.window, &cap)
            .await
            .map_err(|_| "managed workspace preparation unknown")?;
        let mut observer = Observer {
            command,
            manager: managed.context.manager.clone(),
            window: managed.context.window,
            cap: cap.clone(),
            runtime: tokio::runtime::Handle::current(),
        };
        observer.nonblocking()?;
        let store = self.store.clone();
        let credential = self.credential.clone();
        let maximum = managed.max_jobs;
        let output_limit = managed.job_output;
        let jobs = self.jobs.clone();
        let profile = self.profile.clone();
        let cancellation = WorkerCancellation::default();
        let child_cancel = cancellation.clone();
        let cleanup = CancelOnDrop(cancellation);
        let command_output = managed.command_output;
        let activated_signal = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let child_activated = activated_signal.clone();
        let spawn_cap = cap.clone();
        let mut task = tokio::task::spawn_blocking(move || {
            let cap = spawn_cap;
            let activated = observer
                .command
                .activate(&observer.manager, &store, &credential, &cap)
                .is_ok();
            if !activated {
                observer.command.cancel();
                // Inert preparation and uncertain activation both require Root
                // cleanup; a negative result is never command success.
                let _retained = (permit, retained);
                let _ = observer.wait(&child_cancel, |_, _| {});
                return Err("managed workspace activation refused");
            }
            child_activated.store(true, std::sync::atomic::Ordering::Release);
            if let Some(source) = background {
                if child_cancel.is_cancelled() {
                    observer.command.cancel();
                    let _retained = (permit, retained);
                    let _ = observer.wait(&child_cancel, |_, _| {});
                    return Err("managed workspace background start cancelled");
                }
                let jobs = jobs.ok_or("managed workspace background disabled")?;
                let id = cap.id();
                let started = jobs.attach_managed(
                    id,
                    &source,
                    maximum,
                    output_limit,
                    move |cancel, consume| {
                        let receipt = observer.wait(cancel, |_, bytes| consume(bytes))?;
                        status(&receipt)
                    },
                )?;
                // The monitor belongs to the durable job, even if the source
                // tool future disappears before its start receipt is returned.
                jobs.monitor(store.clone(), credential.clone(), profile);
                drop((permit, retained));
                return Ok(Err(started));
            }
            let _retained = (permit, retained);
            // Core's bound applies to both streams together. Reserve space
            // for each Capture's explicit omission marker as well.
            let capture_budget = command_output.saturating_sub(128);
            let mut stdout = Capture::new(capture_budget / 2);
            let mut stderr = Capture::new(capture_budget - capture_budget / 2);
            let receipt = observer
                .wait(&child_cancel, |err, bytes| {
                    if err {
                        stderr.push(bytes)
                    } else {
                        stdout.push(bytes)
                    }
                })
                .map_err(|_| "managed workspace cleanup unknown")?;
            let (exit_code, signal) = match status(&receipt) {
                Ok(value) => value,
                Err(WorkerSandboxError::Timeout) => (Some(124), None),
                Err(WorkerSandboxError::Cancelled) => (Some(130), None),
                Err(_) => return Err("managed workspace result unknown"),
            };
            let (stdout, stderr) = captured(stdout, stderr, command_output);
            Ok(Ok(WorkspaceExecOutput {
                stdout,
                stderr,
                exit_code,
                signal,
            }))
        });
        let mut interval = tokio::time::interval(Duration::from_millis(25));
        let mut refused = false;
        let result = loop {
            tokio::select! {
                result=&mut task=>break result.map_err(|_|"managed workspace observer failed")??,
                _=interval.tick(),if !refused && activated_signal.load(std::sync::atomic::Ordering::Acquire)=>{
                    // A fresh Root custody check can include bounded IPC. Do
                    // not race it against the still-held activation writer or
                    // apply the legacy local-filesystem 50ms timeout here.
                    if !self.authorized(&cap).await {refused=true;cleanup.0.cancel();}
                }
            }
        };
        if refused {
            return Err("managed workspace authority changed");
        }
        match result {
            Ok(output) => Ok(output),
            Err(started) => Ok(render::started(&started, managed.job_timeout)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn noisy_both_streams_keep_heads_tails_and_fit_the_single_core_output_bound() {
        let budget = 128 * 1024;
        let mut out = Capture::new((budget - 128) / 2);
        let mut err = Capture::new((budget - 128) / 2);
        out.push(b"stdout head");
        out.push(&vec![b'o'; 200000]);
        out.push(b"stdout tail");
        err.push(b"stderr head");
        err.push(&vec![b'e'; 200000]);
        err.push(b"stderr tail");
        let (out, err) = captured(out, err, budget);
        assert!(out.len() + err.len() <= budget);
        assert!(out.starts_with(b"stdout head") && out.ends_with(b"stdout tail"));
        assert!(err.starts_with(b"stderr head") && err.ends_with(b"stderr tail"));
        let mut out = Capture::new(0);
        out.push(b"noisy");
        let (out, err) = captured(out, Capture::new(0), 1);
        assert!(out.len() + err.len() <= 1);
    }
}
