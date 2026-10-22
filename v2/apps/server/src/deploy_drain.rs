//! Operator deploy drain: pause admission so a restart needs no quiet moment.
//!
//! A root deploy tool creates `<ORKESTR_V2_HOME>/deploy-drain.request`. While it
//! exists this process:
//!
//! * opens no new execution window and joins no follow-up to a live one; every
//!   such intent is queued durably in Core (the same queue as capacity waits),
//!   so the next process admits it in FIFO order;
//! * defers timer fires: due occurrences stay due in Core and the next process
//!   (or this one, after resume) admits them;
//! * retires every live window as soon as it is idle (all roles accepted,
//!   nothing pending), so in-flight work finishes at its own pace.
//!
//! The process acknowledges in `<home>/deploy-drain.status.json` (pid, draining,
//! since, unresolved windows, queued intents). The tool waits until Core shows
//! no unresolved window, stops the unit and starts the new release; it removes
//! the request on timeout to resume admission instead. A request never
//! survives a restart: startup removes a stale one, so drain is per process.
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub const REQUEST_FILE: &str = "deploy-drain.request";
pub const STATUS_FILE: &str = "deploy-drain.status.json";
const POLL: Duration = Duration::from_secs(1);
/// Unknown counts (no owner credential seen yet) are reported as -1.
const UNKNOWN: i64 = -1;

#[derive(Default)]
pub struct DeployDrain {
    draining: AtomicBool,
    since_ms: AtomicI64,
    unresolved: AtomicI64,
    queued: AtomicI64,
    files: Mutex<Option<(PathBuf, PathBuf)>>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct DrainStatus {
    pub pid: u32,
    pub draining: bool,
    pub since_ms: i64,
    /// Execution windows Core still shows unresolved (-1: not yet observed).
    pub unresolved_windows: i64,
    /// Durable window intents waiting for the next admission (-1: unknown).
    pub queued_intents: i64,
    /// Draining and Core shows no unresolved window: safe to stop.
    pub drained: bool,
    pub updated_ms: i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

impl DeployDrain {
    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::Acquire)
    }

    /// Bind to a home directory. A request left by a previous process is
    /// stale by construction (its deploy restarted us) and is removed.
    pub fn bind(&self, home: &Path) {
        let request = home.join(REQUEST_FILE);
        let status = home.join(STATUS_FILE);
        if std::fs::remove_file(&request).is_ok() {
            eprintln!("deploy drain: removed a stale request from a previous process");
        }
        let _ = std::fs::remove_file(&status);
        if let Ok(mut files) = self.files.lock() {
            *files = Some((request, status));
        }
    }

    /// Window runtime observation while draining (or `None` when unknown).
    pub fn observe(&self, unresolved: Option<u32>, queued: Option<usize>) {
        self.unresolved
            .store(unresolved.map_or(UNKNOWN, i64::from), Ordering::Release);
        self.queued.store(
            queued
                .and_then(|value| i64::try_from(value).ok())
                .unwrap_or(UNKNOWN),
            Ordering::Release,
        );
    }

    /// Apply the request file's presence; returns whether the state changed.
    pub fn poll(&self) -> bool {
        let Some(request) = self.request_path() else {
            return false;
        };
        let requested = request.exists();
        if requested == self.is_draining() {
            return false;
        }
        self.set(requested);
        true
    }

    pub(crate) fn set(&self, draining: bool) {
        if draining {
            self.since_ms.store(now_ms(), Ordering::Release);
            self.observe(None, None);
            eprintln!("deploy drain: requested; admission paused, timer fires deferred");
        } else {
            eprintln!("deploy drain: request removed; admission resumed");
        }
        self.draining.store(draining, Ordering::Release);
    }

    fn request_path(&self) -> Option<PathBuf> {
        self.files.lock().ok()?.as_ref().map(|(r, _)| r.clone())
    }

    pub fn status(&self) -> DrainStatus {
        let draining = self.is_draining();
        let unresolved = self.unresolved.load(Ordering::Acquire);
        DrainStatus {
            pid: std::process::id(),
            draining,
            since_ms: if draining {
                self.since_ms.load(Ordering::Acquire)
            } else {
                0
            },
            unresolved_windows: if draining { unresolved } else { UNKNOWN },
            queued_intents: if draining {
                self.queued.load(Ordering::Acquire)
            } else {
                UNKNOWN
            },
            drained: draining && unresolved == 0,
            updated_ms: now_ms(),
        }
    }

    /// Atomically replace the status file (best effort; never blocks serving).
    pub fn write_status(&self) {
        let Some(path) = self
            .files
            .lock()
            .ok()
            .and_then(|f| f.as_ref().map(|(_, s)| s.clone()))
        else {
            return;
        };
        let Ok(body) = serde_json::to_vec(&self.status()) else {
            return;
        };
        let pending = path.with_extension("json.pending");
        if std::fs::write(&pending, body).is_ok() {
            let _ = std::fs::rename(&pending, &path);
        }
    }

    /// Poll the request every second; refresh the status while draining.
    pub fn start(self: &Arc<Self>) {
        let drain = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(POLL).await;
                let Some(drain) = drain.upgrade() else {
                    return;
                };
                if drain.poll() || drain.is_draining() {
                    drain.write_status();
                }
            }
        });
    }
}

#[cfg(test)]
#[path = "deploy_drain_tests.rs"]
mod tests;
