//! Claude and Codex usage for the owner's host page. One dedicated, niced
//! thread reads the configured transcripts incrementally (byte cursors per
//! file) at most once a minute, samples the running provider programs and
//! publishes a snapshot; its state is persisted so a restart does not read
//! the week again. Requests attribute the snapshot's sessions to owners
//! (conversations, threads, coordinators, agents) and never wait for a scan.
pub(crate) mod config;
pub(crate) mod ledger;
pub(crate) mod limits;
pub(crate) mod owners;
pub(crate) mod parse;
pub(crate) mod procs;
pub(crate) mod report;
pub(crate) mod scan;
#[cfg(test)]
mod tests;

use crate::{owner, AppState, Error};
use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
use orkestr_v2_contracts::{AiUsageSource, HostAiUsage};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

pub(crate) const INTERVAL: Duration = Duration::from_secs(60);
/// Bytes read per pass: the first week is read over several passes.
const PASS_BUDGET: u64 = 768 * 1024 * 1024;
const STATE_FILE: &str = "ai-usage-state.json";
const PERSIST_EVERY: u32 = 5;
pub(crate) const COST_BASIS: &str = "API-equivalent estimate";

/// What one pass publishes.
pub(crate) struct Snapshot {
    pub ledger: ledger::Ledger,
    pub programs: Vec<procs::Program>,
    pub config: config::Config,
    pub stats: Vec<scan::SourceStats>,
    pub observed_at_ms: i64,
    pub collecting: bool,
    pub backfill_percent: Option<f32>,
}

static SNAPSHOT: LazyLock<Mutex<Option<Arc<Snapshot>>>> = LazyLock::new(Default::default);

fn snapshot() -> Option<Arc<Snapshot>> {
    SNAPSHOT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// `YYYY-MM-DD` (UTC) of a time, for notes.
pub(crate) fn date_label(t_ms: i64) -> String {
    // Civil-from-days (Howard Hinnant).
    let z = t_ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Persisted {
    version: u32,
    /// Source paths the cursors belong to; a changed list starts over.
    sources: Vec<PathBuf>,
    cursors: Vec<((u64, u64), scan::Cursor)>,
    ledger: ledger::Saved,
}

fn restore(path: &Path, sources: &[PathBuf]) -> Option<(ledger::Ledger, HashMap<(u64, u64), scan::Cursor>)> {
    let raw = std::fs::read(path).ok()?;
    let saved: Persisted = serde_json::from_slice(&raw).ok()?;
    if saved.version != 1 || saved.sources != sources {
        return None;
    }
    let ledger = ledger::Ledger::restore(saved.ledger)?;
    let sessions = ledger.sessions.len() as u32;
    let cursors = saved
        .cursors
        .into_iter()
        .filter(|(_, c)| c.session.is_none_or(|s| s < sessions))
        .collect();
    Some((ledger, cursors))
}

fn persist(path: &Path, sources: &[PathBuf], ledger: &ledger::Ledger, scanner: &scan::Scanner) {
    let state = Persisted {
        version: 1,
        sources: sources.to_vec(),
        cursors: scanner.cursors.iter().map(|(k, c)| (*k, c.clone())).collect(),
        ledger: ledger.save(),
    };
    let Ok(raw) = serde_json::to_vec(&state) else {
        return;
    };
    let next = path.with_extension("json.next");
    if std::fs::write(&next, raw).is_ok() {
        let _ = std::fs::rename(&next, path);
    }
}

fn run(home: PathBuf) {
    // Lowest CPU priority for this thread only (Linux nice is per thread).
    let _ = rustix::process::setpriority_process(None, 19);
    let config = config::load(&home);
    let paths: Vec<PathBuf> = config.sources.iter().map(|s| s.path.clone()).collect();
    let file = home.join(STATE_FILE);
    let (mut ledger, cursors) = restore(&file, &paths).unwrap_or_default();
    let mut scanner = scan::Scanner::new(cursors);
    let mut sampler = procs::Sampler::default();
    let mut first_done = false;
    let mut passes: u32 = 0;
    loop {
        let now = now_ms();
        scanner.pass(&config.sources, &mut ledger, now, PASS_BUDGET);
        ledger.prune(now);
        let programs = sampler.sample();
        let caught_up = !scanner.exhausted;
        first_done |= caught_up;
        let backfill = (!first_done && scanner.total_bytes > 0).then(|| {
            (100.0 - scanner.pending_bytes as f64 * 100.0 / scanner.total_bytes as f64) as f32
        });
        let published = Snapshot {
            ledger: ledger.clone(),
            programs,
            config: config.clone(),
            stats: scanner.stats.clone(),
            observed_at_ms: now_ms(),
            collecting: !first_done,
            backfill_percent: backfill,
        };
        *SNAPSHOT.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(published));
        passes = passes.wrapping_add(1);
        if passes % PERSIST_EVERY == 1 || !first_done {
            persist(&file, &paths, &ledger, &scanner);
        }
        std::thread::sleep(INTERVAL);
    }
}

/// Starts the usage reader for the life of the process (trusted startup only).
pub fn start(home: &Path) {
    let home = home.to_owned();
    let _ = std::thread::Builder::new()
        .name("ai-usage".into())
        .spawn(move || run(home));
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/v2/host/ai-usage", get(read))
}

/// Everything the owner can see that names a session's owner.
async fn directory(state: &AppState, headers: &HeaderMap, coordinator: Vec<bool>) -> owners::Directory {
    let mut dir = owners::Directory {
        coordinator_sources: coordinator,
        ..Default::default()
    };
    let mut lineage: HashMap<String, String> = HashMap::new();
    if let Ok(credential) = crate::browser::credential(headers) {
        if let Ok(found) = state.store.usage_directory_authenticated(&credential).await {
            dir.runs = found
                .runs
                .into_iter()
                .map(|(native, conversation, role)| (native, (conversation, role)))
                .collect();
            dir.names = found.names.into_iter().collect();
            lineage = found.lineage.into_iter().collect();
        }
    }
    if let Some(broker) = &state.desktop_broker {
        if let Some(threads) = state.sidebar_v1.registry(broker).await {
            dir.threads = threads
                .iter()
                .map(|t| owners::Thread {
                    id: t.id.clone(),
                    name: t.whatsapp_group().unwrap_or_else(|| t.name.clone()),
                    codex_thread_id: t.codex_thread_id.clone(),
                    workspace: t.workspace.clone(),
                    conversation: lineage
                        .get(&t.id)
                        .cloned()
                        .or_else(|| t.delegated_conversation().map(|c| c.to_string())),
                })
                .collect();
        }
    }
    if let Some(path) = state.live_map.clone() {
        let host = tokio::task::spawn_blocking(move || {
            crate::live_map::read_host_cached(&path, crate::live_map::MAX_FILE_BYTES)
        })
        .await
        .ok();
        for view in host.map(|h| h.views).unwrap_or_default() {
            let Some(thread) = view.thread_id else { continue };
            if !dir.threads.iter().any(|t| t.id == thread) {
                dir.threads.push(owners::Thread {
                    id: thread.clone(),
                    name: view.name.clone().unwrap_or_else(|| thread.clone()),
                    conversation: lineage.get(&thread).cloned(),
                    ..Default::default()
                });
            }
            for session in view.sessions {
                dir.attached.insert(session.session_id, thread.clone());
            }
        }
    }
    dir
}

pub(crate) fn build(snapshot: &Snapshot, directory: &owners::Directory, now: i64) -> HostAiUsage {
    let inputs = report::Inputs {
        ledger: &snapshot.ledger,
        directory,
        pricing: &snapshot.config.pricing,
        programs: &snapshot.programs,
        sources: &snapshot.config.sources,
        now_ms: now,
    };
    HostAiUsage {
        schema_version: 1,
        collecting: snapshot.collecting,
        backfill_percent: snapshot.backfill_percent,
        observed_at_ms: Some(snapshot.observed_at_ms),
        interval_ms: INTERVAL.as_millis() as u64,
        providers: report::providers(&inputs),
        windows: report::WINDOWS
            .iter()
            .map(|(label, span, step)| report::window(&inputs, label, *span, *step))
            .collect(),
        active: report::active(&inputs),
        processes: report::processes(&snapshot.programs),
        sources: snapshot
            .config
            .sources
            .iter()
            .zip(snapshot.stats.iter().copied().chain(std::iter::repeat(Default::default())))
            .map(|(s, stats)| AiUsageSource {
                provider: s.provider,
                label: s.label.clone(),
                readable: stats.readable,
                files: stats.files,
            })
            .collect(),
        cost_basis: COST_BASIS.into(),
    }
}

fn empty() -> HostAiUsage {
    HostAiUsage {
        schema_version: 1,
        collecting: true,
        backfill_percent: None,
        observed_at_ms: None,
        interval_ms: INTERVAL.as_millis() as u64,
        providers: Vec::new(),
        windows: Vec::new(),
        active: Vec::new(),
        processes: Vec::new(),
        sources: Vec::new(),
        cost_basis: COST_BASIS.into(),
    }
}

/// Owner only: usage, headroom, top consumers and what runs now.
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HostAiUsage>, Error> {
    owner(&state, &headers).await?;
    let Some(snapshot) = snapshot() else {
        return Ok(Json(empty()));
    };
    let coordinator = snapshot.config.sources.iter().map(|s| s.coordinator).collect();
    let directory = directory(&state, &headers, coordinator).await;
    let usage = tokio::task::spawn_blocking(move || build(&snapshot, &directory, now_ms()))
        .await
        .unwrap_or_else(|_| empty());
    Ok(Json(usage))
}
