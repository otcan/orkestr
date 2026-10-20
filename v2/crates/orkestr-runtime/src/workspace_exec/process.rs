//! The command's creating OS thread owns the original Child through wait. No
//! Tokio idle-thread lifetime, process-name cleanup, or queued plain-Child reply.
use super::*;
use crate::workspace_exec::capture::Capture;
use std::{
    io::{self, Read},
    os::unix::process::ExitStatusExt,
    process::{Child, ChildStderr, ChildStdout, Command, ExitStatus},
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc, Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub struct WorkspaceExecProcess {
    id: u32,
    stdout: ChildStdout,
    stderr: ChildStderr,
    cleanup: Option<mpsc::Sender<()>>,
    finished: mpsc::Receiver<Result<ExitStatus>>,
    thread: Option<JoinHandle<()>>,
    limits: WorkerLimits,
    deadline: Instant,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn start(
    mut command: Command,
    mut job: cgroup::Job,
    descriptors: Box<dyn Send>,
    mut readiness: std::os::unix::net::UnixStream,
    limits: WorkerLimits,
    deadline: Instant,
    slot: sandbox::Slot,
    retained: Box<dyn Send>,
) -> Result<WorkspaceExecProcess> {
    let (ready_tx, ready_rx) = mpsc::sync_channel(0);
    let (cleanup_tx, cleanup_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let spawning = Arc::new(AtomicU8::new(0));
    let creator_state = spawning.clone();
    let thread = std::thread::Builder::new()
        .name("workspace-exec".into())
        .spawn(move || {
            // These remain alive even when the caller abandons the start reply.
            let _slot = slot;
            let _retained = retained;
            if Instant::now() >= deadline
                || creator_state
                    .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
            {
                let _ = ready_tx.send(Err(Error::Timeout));
                return;
            }
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(_) => {
                    let _ = ready_tx.send(Err(Error::Io));
                    return;
                }
            };
            drop(command);
            drop(descriptors); // bwrap consumes inherited copies; shell sees none.
            let pipes = (|| {
                let mut byte = [0];
                readiness.read_exact(&mut byte).map_err(|_| Error::Io)?;
                if byte != *b"R" {
                    return Err(Error::Io);
                }
                let out = child.stdout.take().ok_or(Error::Io)?;
                let err = child.stderr.take().ok_or(Error::Io)?;
                linux::nonblocking(&out)?;
                linux::nonblocking(&err)?;
                Ok((child.id(), out, err))
            })();
            let available = pipes.is_ok();
            if ready_tx.send(pipes).is_ok() && available {
                let _ = cleanup_rx.recv(); // disconnection means abandoned ownership.
            }
            let result = finish(&mut job, &mut child, &mut readiness);
            let proven = result.is_ok();
            let _ = done_tx.send(result);
            if !proven {
                // The bounded caller gets refusal. This retained cleanup owner keeps
                // the slot/resources and exact original Child until proof exists.
                // No uncertain sandbox can authorize reuse of its workspace lease.
                while finish(&mut job, &mut child, &mut readiness).is_err() {
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        })
        .map_err(|_| Error::Io)?;
    let ready = match ready_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(ready) => ready,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if spawning
                .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Err(Error::Timeout); // creator cannot enter actual spawn later.
            }
            // Actual spawn already entered while the fence was held. Retain
            // that fence through the synchronous exec/readiness boundary; a
            // timeout must never release authority while a late spawn is possible.
            ready_rx.recv().map_err(|_| Error::Io)?
        }
        Err(_) => return Err(Error::Io),
    };
    match ready {
        Ok((id, stdout, stderr)) => Ok(WorkspaceExecProcess {
            id,
            stdout,
            stderr,
            cleanup: Some(cleanup_tx),
            finished: done_rx,
            thread: Some(thread),
            limits,
            deadline,
        }),
        Err(error) => {
            drop(cleanup_tx);
            // Spawn failures have no child. Setup failures retain their own
            // bounded cleanup; a detached thread remains its authoritative owner.
            if thread.is_finished() {
                let _ = thread.join();
            }
            Err(error)
        }
    }
}
fn finish(
    job: &mut cgroup::Job,
    child: &mut Child,
    witness: &mut std::os::unix::net::UnixStream,
) -> Result<ExitStatus> {
    job.kill_and_empty(Duration::from_secs(2))?;
    let original = child.wait().map_err(|_| Error::Io)?;
    if original.code() != Some(73) {
        return Err(Error::Io);
    }
    let mut bytes = [0; 5];
    witness.read_exact(&mut bytes).map_err(|_| Error::Io)?;
    let status = i32::from_be_bytes(bytes[1..].try_into().map_err(|_| Error::Io)?);
    if bytes[0] != b'D' || !(-64..=255).contains(&status) {
        return Err(Error::Io);
    }
    Ok(ExitStatus::from_raw(if status < 0 {
        -status
    } else {
        status << 8
    }))
}
impl WorkspaceExecProcess {
    /// Restricted contract: exceeding the output bound refuses the command.
    pub fn wait(self, cancellation: &WorkerCancellation) -> Result<WorkerOutput> {
        let limit = self.limits.max_output_bytes;
        let (mut stdout, mut stderr) = (vec![], vec![]);
        let mut total = 0usize;
        let status = self.stream(cancellation, &mut |error, bytes| {
            total += bytes.len();
            if total > limit {
                return Err(Error::OutputLimit);
            }
            (if error { &mut stderr } else { &mut stdout }).extend_from_slice(bytes);
            Ok(())
        })?;
        Ok(WorkerOutput {
            exit_code: status.code(),
            signal: status.signal(),
            stdout,
            stderr,
        })
    }

    /// Trusted contract: output beyond the bound is truncated (head and tail
    /// kept per stream) instead of failing an otherwise finished command.
    pub fn wait_truncated(self, cancellation: &WorkerCancellation) -> Result<WorkerOutput> {
        // Room for each stream's omission marker: the total stays within the
        // bound Core enforces when rendering the result.
        let half = self.limits.max_output_bytes.saturating_sub(256) / 2;
        let (mut stdout, mut stderr) = (Capture::new(half), Capture::new(half));
        let status = self.stream(cancellation, &mut |error, bytes| {
            (if error { &mut stderr } else { &mut stdout }).push(bytes);
            Ok(())
        })?;
        Ok(WorkerOutput {
            exit_code: status.code(),
            signal: status.signal(),
            stdout: stdout.finish(),
            stderr: stderr.finish(),
        })
    }

    /// Long-running job contract: every byte goes to `sink` (stderr=true for
    /// standard error) as it arrives; the sink alone bounds retention.
    pub fn wait_streaming(
        self,
        cancellation: &WorkerCancellation,
        sink: &mut dyn FnMut(bool, &[u8]),
    ) -> Result<(Option<i32>, Option<i32>)> {
        let status = self.stream(cancellation, &mut |error, bytes| {
            sink(error, bytes);
            Ok(())
        })?;
        Ok((status.code(), status.signal()))
    }

    fn stream(
        mut self,
        cancellation: &WorkerCancellation,
        sink: &mut dyn FnMut(bool, &[u8]) -> Result<()>,
    ) -> Result<ExitStatus> {
        let (mut out_eof, mut err_eof) = (false, false);
        loop {
            if cancellation.cancelled() {
                return Err(Error::Cancelled);
            }
            if Instant::now() >= self.deadline {
                return Err(Error::Timeout);
            }
            out_eof |= drain(&mut self.stdout, &mut |b| sink(false, b))?;
            err_eof |= drain(&mut self.stderr, &mut |b| sink(true, b))?;
            // WNOWAIT: only the creating thread may release the original Child.
            if linux::exited(self.id)? {
                self.request_cleanup();
                // Killing the cgroup closes any background descendants' pipe
                // copies. Drain only the already bounded remaining output.
                out_eof |= drain(&mut self.stdout, &mut |b| sink(false, b))?;
                err_eof |= drain(&mut self.stderr, &mut |b| sink(true, b))?;
                if out_eof && err_eof {
                    return self.complete();
                }
                // After cleanup starts, Child may be reaped before the next
                // iteration; only pipe EOF and the retained completion matter.
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        let status = self.complete()?;
        if !drain(&mut self.stdout, &mut |b| sink(false, b))?
            || !drain(&mut self.stderr, &mut |b| sink(true, b))?
        {
            return Err(Error::Io);
        }
        Ok(status)
    }
    fn request_cleanup(&mut self) {
        if let Some(sender) = self.cleanup.take() {
            let _ = sender.send(());
        }
    }
    fn complete(&mut self) -> Result<ExitStatus> {
        self.request_cleanup();
        let result = self
            .finished
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| Error::Io)?;
        if result.is_ok() {
            if let Some(thread) = self.thread.take() {
                thread.join().map_err(|_| Error::Io)?;
            }
        }
        if result.is_err() {
            self.thread.take();
        } // retained cleanup thread continues independently.
        result
    }
}
impl Drop for WorkspaceExecProcess {
    fn drop(&mut self) {
        if self.cleanup.is_some() || self.thread.is_some() {
            let _ = self.complete();
        }
    }
}
fn drain(pipe: &mut impl Read, sink: &mut dyn FnMut(&[u8]) -> Result<()>) -> Result<bool> {
    let mut bytes = [0; 4096];
    for _ in 0..32 {
        match pipe.read(&mut bytes) {
            Ok(0) => return Ok(true),
            Ok(n) => sink(&bytes[..n])?,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => (),
            Err(_) => return Err(Error::Io),
        }
    }
    Ok(false)
}
