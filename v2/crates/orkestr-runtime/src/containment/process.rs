pub(super) use super::reaper::{start_reaper, start_reaper_retained, Reaper};
use super::{
    framing::Framing, scope::Shared, sys, ConsumedTurn, Error, ExecutionScope, Executor, Flush,
    Output, TurnFailure,
};
use serde_json::Value;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize},
    Arc, Mutex,
};

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

pub(super) struct Live {
    pub(super) child: Option<Child>,
    pub(super) framing: Framing,
    pub(super) handoff: Option<super::provider_fd::Handoff>,
    pub(super) provider_writer: Option<super::provider_fd::ProviderWriter>,
}

pub(super) struct Process {
    pub(super) live: Mutex<Live>,
    reaper: Reaper,
    pub(super) workspace: std::path::PathBuf,
    pub(super) max_frame: usize,
    pub(super) broker_launcher: AtomicBool,
    pub(super) offline_python: AtomicBool,
    pub(super) workspace_exec: AtomicBool,
    pub(super) workspace_exec_trusted: AtomicBool,
    pub(super) broker_lineage: Arc<()>,
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
        reaper: &Reaper,
    ) -> Result<Arc<Self>, Error> {
        Self::spawn_config_mode(
            program,
            args,
            directories,
            bounds,
            active,
            reaper,
            false,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn spawn_config_mode(
        program: &std::path::Path,
        args: &[std::ffi::OsString],
        directories: &super::ChildDirectories,
        bounds: super::TransportBounds,
        active: &Arc<AtomicUsize>,
        reaper: &Reaper,
        provider_fd: bool,
        resume_native: Option<super::resume_bootstrap::ResumeBootstrap<'_>>,
    ) -> Result<Arc<Self>, Error> {
        Self::spawn_config_workspace(
            program,
            args,
            directories,
            bounds,
            active,
            reaper,
            provider_fd,
            resume_native,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn spawn_config_workspace(
        program: &std::path::Path,
        args: &[std::ffi::OsString],
        directories: &super::ChildDirectories,
        bounds: super::TransportBounds,
        _active: &Arc<AtomicUsize>,
        reaper: &Reaper,
        provider_fd: bool,
        resume_native: Option<super::resume_bootstrap::ResumeBootstrap<'_>>,
        workspace: Option<super::workspace_launch::WorkspaceDescriptor>,
    ) -> Result<Arc<Self>, Error> {
        use std::os::fd::AsRawFd;
        let logical_workspace = if workspace.is_some() {
            std::path::PathBuf::from("/workspace")
        } else {
            directories.workspace().to_owned()
        };
        let pair = if provider_fd {
            Some(super::provider_fd::Handoff::pair()?)
        } else {
            None
        };
        let bootstrap = resume_native
            .map(|resume| {
                use std::io::Write;
                use std::net::Shutdown;
                use std::os::unix::net::UnixStream;
                if !provider_fd {
                    return Err(Error::InvalidFrame);
                }
                let payload = resume.payload()?;
                let (mut parent, child) = UnixStream::pair().map_err(|_| Error::Io)?;
                parent.set_nonblocking(true).map_err(|_| Error::Io)?;
                // Small, bounded local socket write; never wait for a broker reply.
                if parent.write(&payload).map_err(|_| Error::Io)? != payload.len() {
                    return Err(Error::Io);
                }
                parent.shutdown(Shutdown::Write).map_err(|_| Error::Io)?;
                Ok(child)
            })
            .transpose()?;
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if workspace.is_some() {
            directories.configure_without_cwd(&mut command);
        } else {
            directories.configure(&mut command);
        }
        sys::configure_command(&mut command);
        if let Some((_, socket)) = &pair {
            sys::inherit_handoff(
                &mut command,
                socket.as_raw_fd(),
                bootstrap.as_ref().map(AsRawFd::as_raw_fd),
            )?;
        }
        if let Some(workspace) = workspace {
            workspace.configure(&mut command).map_err(|_| Error::Io)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = reaper.spawn(command)?;
        let handoff = pair.map(|(parent, _)| parent);
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
                handoff,
                provider_writer: None,
            }),
            reaper: reaper.clone(),
            workspace: logical_workspace,
            max_frame: bounds.max_frame_bytes,
            broker_launcher: AtomicBool::new(false),
            offline_python: AtomicBool::new(false),
            workspace_exec: AtomicBool::new(false),
            workspace_exec_trusted: AtomicBool::new(false),
            broker_lineage: Arc::new(()),
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
        live.handoff = None;
        live.provider_writer = None;
        // Even if signalling fails, preserve wait ownership and retained resources.
        if let Some(child) = live.child.take() {
            self.reaper.send(child).map_err(|_| Error::Io)?;
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
        let lineage = dispatch.broker_lineage();
        let (scope, frame) = dispatch.into_submission();
        let result = (|| {
            if frame.len() > self.process.max_frame {
                return Err(Error::FrameTooLarge);
            }
            let canonical = super::broker_frames::turn(&frame, lineage.as_ref(), &self.process)?;
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

    pub(crate) fn quarantine(&self) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.revoked = true;
        }
        let _ = self.process.stop();
    }
    pub(crate) fn write_provider_suffix(
        &self,
        scope: &ExecutionScope,
        bytes: &[u8],
    ) -> Result<usize, Error> {
        self.shared.dispatch(scope, |_| {
            self.process
                .live
                .lock()
                .map_err(|_| Error::Revoked)?
                .provider_writer
                .as_mut()
                .ok_or(Error::AuthorityProtocol)?
                .write_suffix(bytes)
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

    /// Peak resident memory of this child's live process tree (bytes), for
    /// host admission estimates only. The leader stays unreaped while this
    /// handle lives, so its PID cannot name another process.
    pub fn tree_peak_rss_bytes(&self) -> Option<u64> {
        let root = {
            let live = self.process.live.lock().ok()?;
            live.child.as_ref()?.id()
        };
        super::memory::tree_peak_rss_bytes(root)
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
                // Read-only is always allowed: it is never wider than the
                // instance selection (a Fast session always uses it).
                && params
                    .get("sandbox")
                    .and_then(Value::as_str)
                    .is_some_and(|sandbox| {
                        sandbox == crate::provider_access::current().request()
                            || sandbox == crate::provider_access::ProviderAccess::ReadOnly.request()
                    })
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
