use super::process::{start_reaper, Process};
use super::{sys, ChildDirectories, Error, OwnedChild, TransportBounds};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc::Sender, Arc, Mutex, Weak};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionScope {
    namespace: String,
    incarnation: String,
    owner: String,
    session: String,
    run: String,
    generation: u64,
}

impl ExecutionScope {
    pub fn new(
        namespace: &str,
        incarnation: &str,
        owner: &str,
        session: &str,
        run: &str,
        generation: u64,
    ) -> Result<Self, Error> {
        fn valid(value: &str) -> bool {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        }
        if !valid(namespace)
            || !valid(incarnation)
            || !valid(owner)
            || !valid(session)
            || !valid(run)
            || generation == 0
        {
            return Err(Error::InvalidScope);
        }
        Ok(Self {
            namespace: namespace.into(),
            incarnation: incarnation.into(),
            owner: owner.into(),
            session: session.into(),
            run: run.into(),
            generation,
        })
    }
    pub fn namespace(&self) -> &str {
        &self.namespace
    }
    pub fn incarnation_id(&self) -> &str {
        &self.incarnation
    }
    pub fn owner(&self) -> &str {
        &self.owner
    }
    pub fn session(&self) -> &str {
        &self.session
    }
    pub fn run(&self) -> &str {
        &self.run
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

/// Core/Runtime must implement a current durable scope fence, invoking `action`
/// synchronously exactly once iff current. Scope freshness is NOT a consumed
/// turn capability. No permissive production implementation is provided.
/// Lock order: durable fence -> local authority -> child. Cancellation must
/// commit its durable fence before calling local Authority::revoke().
pub trait DispatchFence: Send + Sync {
    fn dispatch(
        &self,
        scope: &ExecutionScope,
        action: &mut dyn FnMut() -> Result<(), Error>,
    ) -> Result<(), Error>;
}

pub(super) struct State {
    pub revoked: bool,
    pub children: BTreeMap<u64, Weak<Process>>,
    pub next: u64,
}

pub(super) struct Shared {
    pub scope: ExecutionScope,
    pub fence: Arc<dyn DispatchFence>,
    pub state: Mutex<State>,
    pub active: Arc<AtomicUsize>,
    pub maximum: usize,
    pub reaper: Sender<Child>,
}

impl Shared {
    pub fn check(&self, scope: &ExecutionScope, state: &State) -> Result<(), Error> {
        if scope != &self.scope {
            return Err(Error::WrongScope);
        }
        if state.revoked {
            return Err(Error::Revoked);
        }
        Ok(())
    }

    pub fn dispatch<T>(
        &self,
        scope: &ExecutionScope,
        mut action: impl FnMut(&mut State) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let mut called = false;
        let mut output = None;
        let result = self.fence.dispatch(scope, &mut || {
            if called {
                return Err(Error::AuthorityProtocol);
            }
            called = true;
            let mut state = self.state.lock().map_err(|_| Error::Revoked)?;
            self.check(scope, &state)?;
            output = Some(action(&mut state)?);
            Ok(())
        });
        result?;
        if !called {
            return Err(Error::AuthorityProtocol);
        }
        output.ok_or(Error::AuthorityProtocol)
    }
}

/// Trusted composition boundary, not an HTTP/worker constructor. Requires a real
/// durable fence; raw paths, scope strings or environment alone grant nothing.
pub struct Authority {
    pub(super) shared: Arc<Shared>,
}

impl Authority {
    pub fn new(
        scope: ExecutionScope,
        fence: Arc<dyn DispatchFence>,
        maximum_children: usize,
    ) -> Result<Self, Error> {
        sys::supported()?;
        if !(1..=64).contains(&maximum_children) {
            return Err(Error::InvalidBounds);
        }
        let active = Arc::new(AtomicUsize::new(0));
        let reaper = start_reaper(active.clone())?;
        Ok(Self {
            shared: Arc::new(Shared {
                scope,
                fence,
                state: Mutex::new(State {
                    revoked: false,
                    children: BTreeMap::new(),
                    next: 1,
                }),
                active,
                maximum: maximum_children,
                reaper,
            }),
        })
    }

    /// Trusted, immutable executable/arguments. Never use web/model-controlled
    /// program/args here. Home is disposable; subscription access uses a broker.
    pub fn issue_executor(
        &self,
        scope: &ExecutionScope,
        program: &Path,
        args: &[OsString],
        directories: ChildDirectories,
        bounds: TransportBounds,
    ) -> Result<Executor, Error> {
        let bounds = bounds.validate()?;
        if !program.is_absolute() || !program.is_file() {
            return Err(Error::InvalidPath);
        }
        let program = program.canonicalize().map_err(|_| Error::InvalidPath)?;
        let state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        self.shared.check(scope, &state)?;
        Ok(Executor {
            shared: self.shared.clone(),
            program,
            args: args.to_vec(),
            directories,
            bounds,
        })
    }

    /// Opaque locator held by the trusted broker, never environment/argv/Debug.
    pub fn issue_subscription(
        &self,
        scope: &ExecutionScope,
        locator: String,
    ) -> Result<SubscriptionHandle, Error> {
        if locator.is_empty() || locator.len() > 4096 || locator.contains('\0') {
            return Err(Error::InvalidScope);
        }
        let state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        self.shared.check(scope, &state)?;
        Ok(SubscriptionHandle {
            shared: self.shared.clone(),
            locator,
        })
    }

    /// Callback must only enqueue a bounded broker operation. It must not block,
    /// re-enter this authority, or export credentials into child environment.
    pub fn with_subscription<T>(
        &self,
        scope: &ExecutionScope,
        handle: &SubscriptionHandle,
        mut enqueue: impl FnMut(&str) -> Result<T, Error>,
    ) -> Result<T, Error> {
        if !Arc::ptr_eq(&self.shared, &handle.shared) {
            return Err(Error::WrongScope);
        }
        self.shared.dispatch(scope, |_| enqueue(&handle.locator))
    }

    /// Local fencing is synchronous. Signals affect only registered owned groups;
    /// waiting/reaping is asynchronous. Durable cancellation precedes this call.
    pub fn revoke(&self) -> Result<(), Error> {
        let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        state.revoked = true;
        let mut failed = false;
        for process in state.children.values().filter_map(Weak::upgrade) {
            if process.stop().is_err() {
                failed = true;
            }
        }
        if failed {
            Err(Error::Io)
        } else {
            Ok(())
        }
    }
}

impl Drop for Authority {
    fn drop(&mut self) {
        let _ = self.revoke();
    }
}

pub struct SubscriptionHandle {
    shared: Arc<Shared>,
    locator: String,
}

pub struct Executor {
    pub(super) shared: Arc<Shared>,
    pub(super) program: PathBuf,
    pub(super) args: Vec<OsString>,
    pub(super) directories: ChildDirectories,
    pub(super) bounds: TransportBounds,
}

impl Executor {
    pub fn spawn(&self, scope: &ExecutionScope) -> Result<OwnedChild, Error> {
        self.shared.dispatch(scope, |state| {
            if self.shared.active.load(Ordering::Acquire) >= self.shared.maximum {
                return Err(Error::Capacity);
            }
            let next = state.next.checked_add(1).ok_or(Error::Capacity)?;
            let process = Process::spawn(self)?;
            state.children.retain(|_, entry| entry.strong_count() > 0);
            state.children.insert(state.next, Arc::downgrade(&process));
            state.next = next;
            Ok(OwnedChild {
                shared: self.shared.clone(),
                process,
            })
        })
    }
}
