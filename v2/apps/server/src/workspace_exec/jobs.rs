//! Detached background jobs for the trusted profile. Each job keeps the same
//! containment as a short command (own cgroup, kill and reap witness) but its
//! lifetime is bounded by the profile's job timeout instead of one tool call.
//! Jobs end on timeout, explicit cancel, profile revocation or server exit
//! (the supervisor's parent-death signal tears down the whole namespace).
use orkestr_runtime::{
    worker_sandbox::{WorkerCancellation, WorkerSandboxError},
    workspace_exec::{capture::Capture, CommandKind, WorkspaceExecSandbox},
};
use orkestr_v2_store_sqlite::{Store, WorkspaceDescriptors, WorkspaceExecProfile};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const TAIL: usize = 4096;
const RETAINED_RECORDS: usize = 64;
const REVOCATION_POLL: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum JobState {
    Running,
    Exited,
    Signaled,
    TimedOut,
    Cancelled,
    Failed,
    /// The server restarted while the job ran; its namespace died with it.
    Lost,
}

/// Durable operational record. Core separately audits the exact command text
/// (delegation source) and every status delivery.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub id: Uuid,
    pub state: JobState,
    pub command_sha256: String,
    pub started_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub output_bytes: u64,
    pub tail: String,
}

struct Job {
    record: Mutex<Record>,
    output: Mutex<Capture>,
    cancel: WorkerCancellation,
}

struct Authority {
    store: Store,
    credential: Arc<str>,
    profile: Arc<WorkspaceExecProfile>,
}

pub(crate) struct Jobs {
    directory: PathBuf,
    live: Mutex<HashMap<Uuid, Arc<Job>>>,
    authority: Mutex<Option<Authority>>,
    monitoring: AtomicBool,
}

pub(super) enum Started {
    Started(Uuid),
    Busy(usize),
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

impl Jobs {
    /// One process-wide registry per private job directory, so a window
    /// restart inside this process never orphans or duplicates live jobs.
    pub(crate) fn for_directory(directory: &Path) -> Result<Arc<Self>, &'static str> {
        static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<Jobs>>>> = OnceLock::new();
        let mut registry = REGISTRY
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "workspace job registry unavailable")?;
        if let Some(existing) = registry.get(directory) {
            return Ok(existing.clone());
        }
        private_directory(directory)?;
        let jobs = Arc::new(Self {
            directory: directory.to_owned(),
            live: Mutex::default(),
            authority: Mutex::default(),
            monitoring: AtomicBool::new(false),
        });
        jobs.sweep_lost();
        registry.insert(directory.to_owned(), jobs.clone());
        Ok(jobs)
    }

    /// Records left `running` by a previous server process are now `lost`.
    fn sweep_lost(&self) {
        let Ok(entries) = std::fs::read_dir(&self.directory) else {
            return;
        };
        for entry in entries.flatten() {
            let Some(id) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(".json"))
                .and_then(|id| Uuid::parse_str(id).ok())
            else {
                continue;
            };
            if let Some(mut record) = self.read(id) {
                if record.state == JobState::Running {
                    record.state = JobState::Lost;
                    record.finished_at_ms = Some(now_ms());
                    self.persist(&record);
                }
            }
        }
    }

    pub(super) fn running(&self) -> usize {
        self.live.lock().map_or(usize::MAX, |live| {
            live.values()
                .filter(|job| {
                    job.record
                        .lock()
                        .is_ok_and(|r| r.state == JobState::Running)
                })
                .count()
        })
    }

    /// Called inside Core's consumed spawn fence with its exact descriptors.
    pub(super) fn start(
        self: &Arc<Self>,
        sandbox: &WorkspaceExecSandbox,
        command: &str,
        workspace: WorkspaceDescriptors<'_>,
    ) -> Result<Started, &'static str> {
        let limits = sandbox
            .limits(CommandKind::Job)
            .ok_or("background jobs are not enabled")?;
        let maximum = sandbox.trusted().map_or(0, |profile| profile.max_jobs);
        let running = self.running();
        if running >= maximum {
            return Ok(Started::Busy(maximum));
        }
        let id = Uuid::new_v4();
        let cancel = WorkerCancellation::default();
        let process = match sandbox.start_job(command, workspace, limits, &cancel, Box::new(())) {
            Ok(process) => process,
            Err(WorkerSandboxError::Busy) => return Ok(Started::Busy(maximum)),
            Err(_) => return Err("workspace job spawn refused"),
        };
        let job = Arc::new(Job {
            record: Mutex::new(Record {
                id,
                state: JobState::Running,
                command_sha256: {
                    use sha2::Digest;
                    format!("{:x}", sha2::Sha256::digest(command.as_bytes()))
                },
                started_at_ms: now_ms(),
                finished_at_ms: None,
                exit_code: None,
                signal: None,
                output_bytes: 0,
                tail: String::new(),
            }),
            output: Mutex::new(Capture::new(limits.max_output_bytes)),
            cancel,
        });
        self.persist(&*job.record.lock().map_err(|_| "workspace job state")?);
        self.live
            .lock()
            .map_err(|_| "workspace job registry unavailable")?
            .insert(id, job.clone());
        let jobs = self.clone();
        // The thread owns the process; dropping it after wait performs the
        // cgroup kill/reap. Spawn failure drops it here with the same contract.
        std::thread::Builder::new()
            .name("workspace-job".into())
            .spawn(move || {
                let result = process.wait_streaming(&job.cancel, &mut |_, bytes| {
                    if let Ok(mut output) = job.output.lock() {
                        output.push(bytes);
                    }
                });
                jobs.finish(&job, result);
            })
            .map_err(|_| "workspace job thread refused")?;
        Ok(Started::Started(id))
    }

    fn finish(&self, job: &Job, result: Result<(Option<i32>, Option<i32>), WorkerSandboxError>) {
        let Ok(mut record) = job.record.lock() else {
            return;
        };
        (record.state, record.exit_code, record.signal) = match result {
            Ok((Some(code), _)) => (JobState::Exited, Some(code), None),
            Ok((None, Some(signal))) => (JobState::Signaled, None, Some(signal)),
            Ok((None, None)) => (JobState::Failed, None, None),
            Err(WorkerSandboxError::Timeout) => (JobState::TimedOut, None, None),
            Err(WorkerSandboxError::Cancelled) => (JobState::Cancelled, None, None),
            Err(_) => (JobState::Failed, None, None),
        };
        record.finished_at_ms = Some(now_ms());
        if let Ok(output) = job.output.lock() {
            record.output_bytes = output.total();
            record.tail = String::from_utf8_lossy(&output.last(TAIL)).into_owned();
        }
        self.persist(&record);
        drop(record);
        self.prune();
    }

    /// Live snapshot, else the durable record of a finished/lost job.
    pub(super) fn snapshot(&self, id: Uuid) -> Option<Record> {
        let live = self.live.lock().ok()?.get(&id).cloned();
        let Some(job) = live else {
            return self.read(id);
        };
        let mut record = job.record.lock().ok()?.clone();
        if record.state == JobState::Running {
            if let Ok(output) = job.output.lock() {
                record.output_bytes = output.total();
                record.tail = String::from_utf8_lossy(&output.last(TAIL)).into_owned();
            }
        }
        Some(record)
    }

    pub(super) fn cancel(&self, id: Uuid) -> bool {
        self.live
            .lock()
            .ok()
            .and_then(|live| live.get(&id).cloned())
            .is_some_and(|job| {
                job.cancel.cancel();
                true
            })
    }

    fn cancel_all(&self) {
        if let Ok(live) = self.live.lock() {
            live.values().for_each(|job| job.cancel.cancel());
        }
    }

    /// Revocation monitor: while any job runs, the exact opt-in must remain
    /// enabled. Any refusal or uncertainty cancels every job (fail closed).
    pub(super) fn monitor(
        self: &Arc<Self>,
        store: Store,
        credential: Arc<str>,
        profile: Arc<WorkspaceExecProfile>,
    ) {
        if let Ok(mut authority) = self.authority.lock() {
            *authority = Some(Authority {
                store,
                credential,
                profile,
            });
        }
        if self.monitoring.swap(true, Ordering::AcqRel) {
            return;
        }
        let jobs = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(REVOCATION_POLL).await;
                if jobs.running() == 0 {
                    jobs.monitoring.store(false, Ordering::Release);
                    if jobs.running() == 0 || jobs.monitoring.swap(true, Ordering::AcqRel) {
                        return;
                    }
                }
                let current = jobs.authority.lock().ok().and_then(|a| {
                    a.as_ref()
                        .map(|a| (a.store.clone(), a.credential.clone(), a.profile.clone()))
                });
                let allowed = match current {
                    Some((store, credential, profile)) => matches!(
                        tokio::time::timeout(
                            Duration::from_secs(5),
                            store.check_workspace_exec_profile(&credential, &profile),
                        )
                        .await,
                        Ok(Ok(()))
                    ),
                    None => false,
                };
                if !allowed {
                    jobs.cancel_all();
                }
            }
        });
    }

    fn path(&self, id: Uuid) -> PathBuf {
        self.directory.join(format!("{}.json", id.hyphenated()))
    }

    fn read(&self, id: Uuid) -> Option<Record> {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(self.path(id))
            .ok()?
            .take(64 * 1024)
            .read_to_end(&mut bytes)
            .ok()?;
        serde_json::from_slice::<Record>(&bytes)
            .ok()
            .filter(|record| record.id == id)
    }

    fn persist(&self, record: &Record) {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let target = self.path(record.id);
        let temporary = target.with_extension("json.tmp");
        let written = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&serde_json::to_vec(record).unwrap_or_default())?;
            file.sync_all()?;
            std::fs::rename(&temporary, &target)
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
    }

    /// Keep memory and the record directory bounded; never drop a running job.
    fn prune(&self) {
        if let Ok(mut live) = self.live.lock() {
            let mut finished: Vec<(i64, Uuid)> = live
                .iter()
                .filter_map(|(id, job)| {
                    let record = job.record.lock().ok()?;
                    (record.state != JobState::Running)
                        .then(|| (record.finished_at_ms.unwrap_or(0), *id))
                })
                .collect();
            finished.sort();
            let excess = finished.len().saturating_sub(16);
            for (_, id) in finished.into_iter().take(excess) {
                live.remove(&id);
            }
        }
        let Ok(entries) = std::fs::read_dir(&self.directory) else {
            return;
        };
        let mut records: Vec<(std::time::SystemTime, PathBuf)> = entries
            .flatten()
            .filter(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(".json")))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        records.sort();
        let excess = records.len().saturating_sub(RETAINED_RECORDS);
        for (_, path) in records.into_iter().take(excess) {
            let running = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| Uuid::parse_str(s).ok())
                .and_then(|id| self.read(id))
                .is_some_and(|r| r.state == JobState::Running);
            if !running {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn private_directory(directory: &Path) -> Result<(), &'static str> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    if !directory.is_absolute() {
        return Err("workspace job directory must be absolute");
    }
    match std::fs::DirBuilder::new().mode(0o700).create(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("workspace job directory unavailable"),
    }
    let meta = std::fs::symlink_metadata(directory).map_err(|_| "workspace job directory")?;
    // Same owner as the private server home that contains it.
    if !meta.is_dir()
        || meta.permissions().mode() & 0o077 != 0
        || meta.uid()
            != std::fs::metadata(directory.parent().unwrap_or(directory))
                .map_err(|_| "workspace job directory")?
                .uid()
    {
        return Err("workspace job directory must be private");
    }
    Ok(())
}

#[cfg(test)]
#[path = "jobs_tests.rs"]
mod tests;
