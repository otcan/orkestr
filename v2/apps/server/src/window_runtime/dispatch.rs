//! Durable window-intent dispatch. Core's queue rows are the only record of
//! pending intent; this task holds no authority beyond the owner's current
//! browser session, which Core re-authenticates on every call.
//!
//! The latest authenticated browser credential is retained in memory only so
//! queued intents can start without another request. Core rejects it once the
//! session expires or logs out; queued rows then wait for the next sign-in.
use super::controller::Controller;
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::{
    ExecutionWindowQueued, ExecutionWindowRequest, ExecutionWindowState, ExecutionWindowStatus,
    QueuedWindowWithdrawal,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};
use tokio::sync::{watch, Notify};

const POLL: Duration = Duration::from_secs(1);
/// Admission errors never consume intent; retry without a busy loop.
const RETRY_BASE: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(60);
/// Bounded work per dispatch pass; later rows wait for the next pass.
const MAX_ROUNDS: usize = 32;
/// A follow-up needs this much remaining work time, else it waits for close.
const FOLLOW_UP_MARGIN_MS: i64 = 5_000;
/// A follow-up joins a live window only if it can still get this much work
/// time there (now, or by extension within the window's lifetime ceiling).
/// Otherwise it waits and opens the successor window, which resumes the same
/// native session.
pub(super) const FOLLOW_UP_MIN_WORK_MS: i64 = 600_000;

/// Whether a follow-up may join this live window rather than its successor.
pub(super) fn joinable(status: &ExecutionWindowStatus, now_ms: i64, max_lifetime_ms: i64) -> bool {
    let ceiling = status
        .opened_at_ms
        .saturating_add(max_lifetime_ms)
        .saturating_sub(orkestr_v2_store_sqlite::EXECUTION_WINDOW_CLEANUP_MS);
    status.state == ExecutionWindowState::Active
        && status.work_deadline_ms > now_ms.saturating_add(FOLLOW_UP_MARGIN_MS)
        && status.work_deadline_ms.max(ceiling) >= now_ms.saturating_add(FOLLOW_UP_MIN_WORK_MS)
}

pub(crate) struct QueueState {
    credential: Mutex<Option<String>>,
    failures: Mutex<HashMap<String, (u32, Instant)>>,
    wake: Notify,
    pending: AtomicBool,
    swept: AtomicBool,
    closed: AtomicBool,
    stop: watch::Sender<bool>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Default for QueueState {
    fn default() -> Self {
        Self {
            credential: Mutex::new(None),
            failures: Mutex::new(HashMap::new()),
            wake: Notify::new(),
            // Rows may survive a restart; the first pass discovers them.
            pending: AtomicBool::new(true),
            swept: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            stop: watch::channel(false).0,
            task: Mutex::new(None),
        }
    }
}
impl QueueState {
    pub(super) fn remember(&self, browser: &str) {
        if let Ok(mut credential) = self.credential.lock() {
            if credential.as_deref() != Some(browser) {
                *credential = Some(browser.to_owned());
            }
        }
        self.wake.notify_one();
    }
    fn forget(&self, browser: &str) {
        if let Ok(mut credential) = self.credential.lock() {
            if credential.as_deref() == Some(browser) {
                *credential = None;
            }
        }
    }
    fn credential(&self) -> Option<String> {
        self.credential.lock().ok()?.clone()
    }
    pub(super) fn wake(&self) {
        self.pending.store(true, Ordering::Release);
        self.wake.notify_one();
    }
    pub(super) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    fn retry_due(&self, key: &str) -> bool {
        self.failures.lock().is_ok_and(|failures| {
            failures
                .get(key)
                .is_none_or(|(_, next)| Instant::now() >= *next)
        })
    }
    fn failed(&self, key: &str) -> u32 {
        let Ok(mut failures) = self.failures.lock() else {
            return 0;
        };
        let retry = failures
            .entry(key.to_owned())
            .or_insert((0, Instant::now()));
        retry.0 = retry.0.saturating_add(1);
        retry.1 = Instant::now()
            + RETRY_BASE
                .saturating_mul(1 << retry.0.saturating_sub(1).min(4))
                .min(RETRY_MAX);
        retry.0
    }
    fn settled(&self, key: &str) {
        if let Ok(mut failures) = self.failures.lock() {
            failures.remove(key);
        }
    }
    pub(super) async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let _ = self.stop.send(true);
        let task = self.task.lock().ok().and_then(|mut task| task.take());
        if let Some(task) = task {
            let _ = task.await;
        }
        if let Ok(mut credential) = self.credential.lock() {
            *credential = None;
        }
    }
}

enum Plan {
    Admit(ExecutionWindowRequest),
    Wait,
    Withdraw(QueuedWindowWithdrawal),
}

/// Rebuild the request against the conversation's current durable window.
fn plan(
    row: &ExecutionWindowQueued,
    status: Option<&ExecutionWindowStatus>,
    now_ms: i64,
    max_lifetime_ms: i64,
) -> Plan {
    let mut request = ExecutionWindowRequest {
        request_key: row.request_key.clone(),
        input_message_id: row.input_message_id.clone(),
        input_event_id: row.input_event_id.clone(),
        input_request_key: row.input_request_key.clone(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    };
    match status {
        None => {}
        Some(status) => {
            request.expected_generation = status.generation;
            match status.state {
                ExecutionWindowState::Closed => {
                    request.predecessor_window_id = Some(status.window_id)
                }
                ExecutionWindowState::Active if joinable(status, now_ms, max_lifetime_ms) => {
                    request.window_id = Some(status.window_id)
                }
                ExecutionWindowState::ReconciliationRequired => {
                    return Plan::Withdraw(QueuedWindowWithdrawal::ReconciliationRequired)
                }
                _ => return Plan::Wait,
            }
        }
    }
    Plan::Admit(request)
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(i64::MAX)
}

impl Controller {
    /// Another trusted producer (the timer scheduler) queued durable intents.
    pub(crate) fn wake_dispatcher(&self) {
        self.queue.wake();
    }

    /// Start the background dispatcher. It holds only a weak controller link.
    pub(crate) fn start_dispatcher(self: &Arc<Self>) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let weak = Arc::downgrade(self);
        let mut stop = self.queue.stop.subscribe();
        let task = runtime.spawn(async move {
            loop {
                let Some(controller) = Weak::upgrade(&weak) else {
                    return;
                };
                tokio::select! {
                    _ = controller.queue.wake.notified() => {}
                    _ = tokio::time::sleep(POLL) => {}
                    _ = stop.changed() => return,
                }
                if controller.queue.is_closed() {
                    return;
                }
                if controller.drain.is_draining() {
                    controller.drain_step().await;
                } else {
                    controller.dispatch_once().await;
                }
                controller.auto_accept_once().await;
            }
        });
        if let Ok(mut slot) = self.queue.task.lock() {
            *slot = Some(task);
        }
    }

    pub(super) async fn dispatch_once(&self) {
        if !self.queue.pending.load(Ordering::Acquire) {
            return;
        }
        let Some(browser) = self.queue.credential() else {
            return;
        };
        let _opening = self.opening.lock().await;
        if self.queue.is_closed() {
            return;
        }
        self.sweep(&browser).await;
        self.reconcile_expired_locked(&browser).await;
        self.drain_locked(&browser).await;
    }

    /// One deploy-drain pass: admit nothing, retire every live window of this
    /// process once it is idle, reconcile released ones, and report Core's
    /// unresolved windows and queued intents to the drain status.
    pub(super) async fn drain_step(&self) {
        // Queued rows are admitted by the first ordinary pass after resume.
        self.queue.pending.store(true, Ordering::Release);
        let Some(browser) = self.queue.credential() else {
            self.drain.observe(None, None);
            return;
        };
        let _opening = self.opening.lock().await;
        if self.queue.is_closed() {
            return;
        }
        self.sweep(&browser).await;
        self.reconcile_expired_locked(&browser).await;
        for (_, entry) in self.entries_by_conversation() {
            if !entry.has_local_task().await {
                continue;
            }
            if let Err(reason) = entry.retire_if_idle(&browser).await {
                eprintln!("deploy drain: idle window retirement failed: {reason}");
            }
        }
        let unresolved = self
            .store
            .unresolved_execution_windows_authenticated(&browser)
            .await
            .ok()
            .and_then(|windows| u32::try_from(windows.len()).ok());
        let queued = self
            .store
            .execution_window_queue_authenticated(&browser, None)
            .await
            .ok()
            .map(|rows| rows.len());
        self.drain.observe(unresolved, queued);
    }

    /// Once per process: windows left unfinished by a previous process have no
    /// local owner. Mark each uncertain so it blocks only its own conversation
    /// and stops consuming capacity. Caller holds `opening`.
    pub(super) async fn sweep(&self, browser: &str) {
        if self.queue.swept.load(Ordering::Acquire) {
            return;
        }
        let Ok(unresolved) = self
            .store
            .unresolved_execution_windows_authenticated(browser)
            .await
        else {
            return;
        };
        let mut complete = true;
        for status in unresolved {
            let local = match self.existing(&status.conversation_id) {
                Some(entry) => entry.has_local_task().await,
                None => false,
            };
            if !local
                && self
                    .store
                    .reconcile_execution_window_authenticated(
                        browser,
                        &status.conversation_id,
                        status.window_id,
                        status.generation,
                    )
                    .await
                    .is_err()
            {
                complete = false;
            }
        }
        self.queue.swept.store(complete, Ordering::Release);
    }

    /// Admit queued intents in FIFO order while live capacity allows. Only the
    /// earliest row of each conversation is eligible, preserving its order.
    /// Caller holds `opening`, so no other fresh window can race the count.
    pub(super) async fn drain_locked(&self, browser: &str) {
        for _ in 0..MAX_ROUNDS {
            match self.drain_round(browser).await {
                Ok(true) => continue,
                Ok(false) => return,
                Err(RuntimeStoreError::Unauthorized) => {
                    self.queue.forget(browser);
                    return;
                }
                Err(_) => {
                    eprintln!("window dispatch deferred: store unavailable");
                    return;
                }
            }
        }
    }

    async fn drain_round(&self, browser: &str) -> Result<bool, RuntimeStoreError> {
        let rows = self
            .store
            .execution_window_queue_authenticated(browser, None)
            .await?;
        if rows.is_empty() {
            self.queue.pending.store(false, Ordering::Release);
            return Ok(false);
        }
        let mut live = self
            .store
            .live_execution_windows_authenticated(browser)
            .await?;
        let queued: HashSet<_> = rows.iter().map(|row| row.conversation_id.clone()).collect();
        let mut seen = HashSet::new();
        let mut progressed = false;
        for row in rows {
            if !seen.insert(row.conversation_id.clone()) {
                continue;
            }
            let conversation = &row.conversation_id;
            let status = self
                .store
                .execution_window_status_authenticated(browser, conversation)
                .await?;
            let lifetime = self.config.window_max_lifetime_ms_for(conversation);
            let request = match plan(&row, status.as_ref(), now_ms(), lifetime) {
                Plan::Wait => continue,
                Plan::Withdraw(reason) => {
                    self.withdraw(browser, &row, reason).await?;
                    progressed = true;
                    continue;
                }
                Plan::Admit(request) => request,
            };
            let fresh = request.window_id.is_none();
            if fresh && live >= self.capacity {
                if !self.reclaim_idle(browser, &queued).await {
                    continue;
                }
                live = live.saturating_sub(1);
            }
            // Source still eligible (not held, consumed or admitted elsewhere)?
            match self
                .store
                .inspect_execution_window_request_authenticated(browser, conversation, &request)
                .await
            {
                Ok(_) => {}
                Err(RuntimeStoreError::Unauthorized) => {
                    return Err(RuntimeStoreError::Unauthorized)
                }
                Err(RuntimeStoreError::Fenced | RuntimeStoreError::Conflict) => {
                    self.withdraw(browser, &row, QueuedWindowWithdrawal::InputUnavailable)
                        .await?;
                    progressed = true;
                    continue;
                }
                Err(error) => return Err(error),
            }
            let Ok(entry) = self.entry(conversation) else {
                continue;
            };
            // Event identity is owner-wide; request keys may repeat across conversations.
            let retry_key = row.input_event_id.to_string();
            if !self.queue.retry_due(&retry_key) {
                continue;
            }
            let owner = self.config.owner_id.clone();
            let result = entry.process(browser, &owner, conversation, &request).await;
            if let Err(reason) = &result {
                // Static local diagnostics only; never provider text or tokens.
                eprintln!("window dispatch refused: {reason}");
            }
            match result {
                Ok(_) => {
                    self.queue.settled(&retry_key);
                    live += u32::from(fresh);
                    progressed = true;
                }
                Err(_) if self.queue.failed(&retry_key) == 3 => {
                    // The occurrence already advanced its timer. Withdrawing it
                    // here silently loses the only durable execution intent.
                    eprintln!("ALERT orkestr-v2-server window_queue_deferred conversation={} event={} cause=admission_refused", row.conversation_id, row.input_event_id);
                }
                Err(_) => {}
            }
        }
        Ok(progressed)
    }

    /// Free one slot by retiring the oldest idle live window: every role
    /// accepted, nothing pending in Core. Conversations in `keep` (the caller's
    /// own, or any with queued intents) are never reclaimed. Caller holds
    /// `opening`. Idle windows otherwise stay open for follow-ups until expiry.
    pub(super) async fn reclaim_idle(
        &self,
        browser: &str,
        keep: &HashSet<orkestr_v2_contracts::ConversationId>,
    ) -> bool {
        let Ok(live) = self
            .store
            .unresolved_execution_windows_authenticated(browser)
            .await
        else {
            return false;
        };
        let now = now_ms();
        for status in live {
            if status.expires_at_ms <= now || keep.contains(&status.conversation_id) {
                continue;
            }
            let Some(entry) = self.existing(&status.conversation_id) else {
                continue;
            };
            match entry.retire_if_idle(browser).await {
                Ok(true) => return true,
                Ok(false) => {}
                Err(reason) => eprintln!("idle window reclamation failed: {reason}"),
            }
        }
        false
    }

    async fn withdraw(
        &self,
        browser: &str,
        row: &ExecutionWindowQueued,
        reason: QueuedWindowWithdrawal,
    ) -> Result<(), RuntimeStoreError> {
        self.queue.settled(&row.input_event_id.to_string());
        let result = self
            .store
            .withdraw_queued_execution_window_authenticated(
                browser,
                &row.conversation_id,
                &row.request_key,
                reason,
            )
            .await?;
        if result.state == orkestr_v2_contracts::QueuedWindowState::Withdrawn {
            let cause = match reason {
                QueuedWindowWithdrawal::InputUnavailable => "input_unavailable",
                QueuedWindowWithdrawal::ReconciliationRequired => "reconciliation_required",
                QueuedWindowWithdrawal::AdmissionRefused => "admission_refused",
            };
            eprintln!("ALERT orkestr-v2-server window_queue_withdrawn conversation={} event={} cause={cause}", row.conversation_id, row.input_event_id);
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod tests;
