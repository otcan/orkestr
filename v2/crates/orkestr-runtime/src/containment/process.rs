use super::{
    framing::Framing, scope::Shared, sys, ConsumedTurn, Error, ExecutionScope, Executor, Flush,
    Output, TurnFailure,
};
use serde_json::Value;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc::{self, Sender},
    Arc, Mutex,
};
use std::time::Duration;

#[derive(Clone, Copy)]
pub enum Signal {
    Terminate,
    Kill,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

pub(super) fn start_reaper(active: Arc<AtomicUsize>) -> Result<Sender<Child>, Error> {
    // At most maximum_children outstanding Child values, including reaper work:
    // the capacity slot is released only after wait, never on handle drop.
    let (sender, receiver) = mpsc::channel::<Child>();
    std::thread::Builder::new()
        .name("contained-reaper".into())
        .spawn(move || {
            let mut pending = Vec::new();
            let mut disconnected = false;
            loop {
                match receiver.recv_timeout(Duration::from_millis(5)) {
                    Ok(child) => pending.push(child),
                    Err(mpsc::RecvTimeoutError::Disconnected) => disconnected = true,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                let mut index = 0;
                while index < pending.len() {
                    match pending[index].try_wait() {
                        Ok(None) => index += 1,
                        Ok(Some(_)) => {
                            let mut child = pending.swap_remove(index);
                            // try_wait cached this status; wait cannot block.
                            let _ = child.wait();
                            active.fetch_sub(1, Ordering::AcqRel);
                        }
                        // Retain ownership/capacity on observation failure.
                        Err(_) => index += 1,
                    }
                }
                if disconnected && pending.is_empty() {
                    break;
                }
                if disconnected {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        })
        .map_err(|_| Error::Io)?;
    Ok(sender)
}

pub(super) struct Live {
    pub(super) child: Option<Child>,
    pub(super) framing: Framing,
}

pub(super) struct Process {
    pub(super) live: Mutex<Live>,
    reaper: Sender<Child>,
    pub(super) workspace: std::path::PathBuf,
    pub(super) max_frame: usize,
}

impl Process {
    pub fn spawn(executor: &Executor) -> Result<Arc<Self>, Error> {
        Self::spawn_config(
            &executor.program,
            &executor.args,
            &executor.directories,
            executor.bounds,
            &executor.shared.active,
            &executor.shared.reaper,
        )
    }

    pub(super) fn spawn_config(
        program: &std::path::Path,
        args: &[std::ffi::OsString],
        directories: &super::ChildDirectories,
        bounds: super::TransportBounds,
        active: &Arc<AtomicUsize>,
        reaper: &Sender<Child>,
    ) -> Result<Arc<Self>, Error> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        directories.configure(&mut command);
        sys::configure_command(&mut command);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|_| Error::Io)?;
        active.fetch_add(1, Ordering::AcqRel);
        let input = child.stdin.take().ok_or(Error::Io);
        let output = child.stdout.take().ok_or(Error::Io);
        let pipes = input.and_then(|input| output.map(|output| (input, output)));
        let pipes = pipes.and_then(|(input, output)| {
            sys::nonblocking(&input)?;
            sys::nonblocking(&output)?;
            Ok((input, output))
        });
        let (input, output) = match pipes {
            Ok(pipes) => pipes,
            Err(error) => {
                let _ = sys::signal_group(child.id(), Signal::Kill);
                let _ = reaper.send(child);
                return Err(error);
            }
        };
        Ok(Arc::new(Self {
            live: Mutex::new(Live {
                child: Some(child),
                framing: Framing::new(input, output, bounds),
            }),
            reaper: reaper.clone(),
            workspace: directories.workspace().to_owned(),
            max_frame: bounds.max_frame_bytes,
        }))
    }

    pub fn stop(&self) -> Result<(), Error> {
        let mut live = self.live.lock().map_err(|_| Error::Revoked)?;
        let result = if let Some(child) = &live.child {
            sys::signal_group(child.id(), Signal::Kill)
        } else {
            Ok(())
        };
        // Even a signal error quarantines I/O; never grant a retry/replacement.
        live.framing.close();
        if result.is_ok() {
            if let Some(child) = live.child.take() {
                self.reaper.send(child).map_err(|_| Error::Io)?;
            }
        }
        result
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// No raw Child, PID, Command, stdin fd or mutable environment is exposed.
/// A handle cannot signal another process, and all signals target its own group.
pub struct OwnedChild {
    pub(super) shared: Arc<Shared>,
    pub(super) process: Arc<Process>,
}

impl OwnedChild {
    /// Metadata is bounded and method/parameter-whitelisted. This cannot submit
    /// turn/start, tool commands, authentication writes or token refreshes.
    pub fn enqueue_metadata(&self, scope: &ExecutionScope, frame: &[u8]) -> Result<(), Error> {
        if frame.len() > self.process.max_frame {
            return Err(Error::FrameTooLarge);
        }
        let canonical = validate_metadata(frame, &self.process.workspace)?;
        self.enqueue(scope, &canonical)
    }

    /// Only Runtime's private wrapper may implement ConsumedTurn. It takes the
    /// Core non-Clone consumed dispatch by value. All failure paths reconcile.
    #[allow(
        dead_code,
        reason = "Runtime consumed-capability adapter is registered separately"
    )]
    pub(crate) fn enqueue_turn<D: ConsumedTurn>(&self, dispatch: D) -> Result<(), TurnFailure> {
        let (scope, frame) = dispatch.into_submission();
        let result = (|| {
            if frame.len() > self.process.max_frame {
                return Err(Error::FrameTooLarge);
            }
            let value: Value = serde_json::from_slice(&frame).map_err(|_| Error::InvalidFrame)?;
            if value.get("method").and_then(Value::as_str) != Some("turn/start") {
                return Err(Error::InvalidFrame);
            }
            let canonical = serde_json::to_vec(&value).map_err(|_| Error::InvalidFrame)?;
            self.enqueue(&scope, &canonical)
        })();
        result.map_err(|cause| TurnFailure { cause })
    }

    fn enqueue(&self, scope: &ExecutionScope, frame: &[u8]) -> Result<(), Error> {
        self.shared.dispatch(scope, |_| {
            self.process
                .live
                .lock()
                .map_err(|_| Error::Revoked)?
                .framing
                .enqueue(frame)
        })
    }

    pub fn flush_stdin(&self, scope: &ExecutionScope) -> Result<Flush, Error> {
        self.shared.dispatch(scope, |_| {
            let mut live = self.process.live.lock().map_err(|_| Error::Revoked)?;
            let result = live.framing.flush();
            if result.is_err() {
                live.framing.close();
            }
            result
        })
    }

    pub fn poll_stdout(&self, scope: &ExecutionScope) -> Result<Output, Error> {
        let state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        self.shared.check(scope, &state)?;
        let mut live = self.process.live.lock().map_err(|_| Error::Revoked)?;
        let result = live.framing.read();
        if result.is_err() {
            live.framing.close();
        }
        result
    }

    /// Nonblocking WNOWAIT observation: leader remains unreaped until teardown.
    pub fn poll_exit(&self, scope: &ExecutionScope) -> Result<Option<Exit>, Error> {
        let state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        self.shared.check(scope, &state)?;
        let live = self.process.live.lock().map_err(|_| Error::Revoked)?;
        sys::observe_exit(live.child.as_ref().ok_or(Error::PipeClosed)?.id())
    }

    pub fn signal(&self, scope: &ExecutionScope, signal: Signal) -> Result<(), Error> {
        self.shared.dispatch(scope, |_| {
            let live = self.process.live.lock().map_err(|_| Error::Revoked)?;
            sys::signal_group(live.child.as_ref().ok_or(Error::PipeClosed)?.id(), signal)
        })
    }
}

pub(super) fn validate_metadata(
    frame: &[u8],
    workspace: &std::path::Path,
) -> Result<Vec<u8>, Error> {
    // Bound before JSON parsing, even when a caller bypasses framing limits.
    if frame.len() > 1048576 {
        return Err(Error::FrameTooLarge);
    }
    let value: Value = serde_json::from_slice(frame).map_err(|_| Error::InvalidFrame)?;
    let object = value.as_object().ok_or(Error::InvalidFrame)?;
    if object
        .keys()
        .any(|key| !["id", "method", "params"].contains(&key.as_str()))
    {
        return Err(Error::InvalidFrame);
    }
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .ok_or(Error::InvalidFrame)?;
    if method == "initialized" {
        return if object.len() == 1 {
            serde_json::to_vec(&value).map_err(|_| Error::InvalidFrame)
        } else {
            Err(Error::InvalidFrame)
        };
    }
    if !value
        .get("id")
        .and_then(Value::as_u64)
        .is_some_and(|id| id > 0)
    {
        return Err(Error::InvalidFrame);
    }
    let params = value
        .get("params")
        .and_then(Value::as_object)
        .ok_or(Error::InvalidFrame)?;
    let valid = match method {
        "initialize" => {
            params
                .keys()
                .all(|key| ["clientInfo", "capabilities"].contains(&key.as_str()))
                && params.get("clientInfo").is_some_and(Value::is_object)
                && params.get("capabilities").is_some_and(|caps| {
                    caps.as_object().is_some_and(|caps| {
                        caps.len() == 1 && caps.get("experimentalApi") == Some(&Value::Bool(false))
                    })
                })
        }
        "account/read" => {
            params.len() == 1 && params.get("refreshToken") == Some(&Value::Bool(false))
        }
        // Read-only sandbox has network off; no configuration, tool, prompt or
        // network overrides accepted. Runtime must validate the server reply.
        "thread/start" => {
            params.len() == 4
                && params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .is_some_and(|cwd| std::path::Path::new(cwd) == workspace)
                && params.get("approvalPolicy").and_then(Value::as_str) == Some("never")
                && params.get("sandbox").and_then(Value::as_str) == Some("read-only")
                && params.get("ephemeral") == Some(&Value::Bool(false))
        }
        _ => false,
    };
    if valid {
        serde_json::to_vec(&value).map_err(|_| Error::InvalidFrame)
    } else {
        Err(Error::InvalidFrame)
    }
}
