//! Restart-safe controller with authenticated supervisor lifecycle.
//! No browser credentials, instruction cache, caller clock or HTTP dispatch port.
use orkestr_v2_store_sqlite::history_import::timers::scan_action::TimerWorkKind;
use orkestr_v2_store_sqlite::{history_import::HistoryError, Store};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::time::Instant;
use uuid::Uuid;
const PAGE: u16 = 32;
/// Retry spacing for a due occurrence that could not be admitted (for example a
/// changed Stop boundary, a removed conversation or a full window queue).
const RETRY_BASE: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(15 * 60);

fn retry_delay(failures: u32) -> Duration {
    RETRY_BASE
        .saturating_mul(1u32 << failures.saturating_sub(1).min(16))
        .min(RETRY_MAX)
}

#[derive(Default, Debug, PartialEq, Eq)]
pub struct DurableTick {
    pub scanned: u32,
    pub admitted: u32,
    /// Not due or concurrently disabled/stopped; no authority is recreated.
    pub deferred: u32,
    /// Runs started by inbound trigger events.
    pub triggered: u32,
    /// Digests created with content.
    pub digests: u32,
    /// Typed mailbox actions; these admit no model or window work.
    pub tracker_actions: u32,
    /// Cross-conversation requests queued, settled or returned (same authority).
    pub thread_asks: u32,
}
/// Own exactly one per authenticated supervisor lifecycle. Not a cloned task pool.
pub struct DurableTimerController {
    supervisor: Store,
    after: Option<Uuid>,
    /// Process-local backoff per namespace; never authority, lost on restart.
    backoff: HashMap<Uuid, (u32, Instant)>,
    /// When a window dispatcher runs, each occurrence also queues its Deep turn.
    queue_window: bool,
    wake: Option<Arc<dyn Fn() + Send + Sync>>,
    /// While true (an operator deploy drain) no occurrence fires; due ones
    /// stay due in Core and fire on a later pass or in the next process.
    paused: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    /// Digests are due at most a few times a day; check twice a minute.
    digest_checked: Option<Instant>,
    tracker_mail: Option<Arc<crate::tracker_mail_runtime::TrackerMailRuntime>>,
    scan_in_progress: Option<Uuid>,
    timeout_retry: Option<Instant>,
    /// Last logged thread-ask refusal, so a lasting one is logged once.
    thread_ask_refusal: Option<String>,
    #[cfg(test)]
    pub(crate) test_scan_delay: Option<Duration>,
    #[cfg(test)]
    pub(crate) test_trigger_delay: Option<(Duration, Arc<std::sync::atomic::AtomicBool>)>,
}
const DIGEST_CHECK: Duration = Duration::from_secs(30);
impl DurableTimerController {
    /// A normal/worker Store cannot pass Core's subsequent context validation.
    pub fn new(supervisor: Store) -> Self {
        Self {
            supervisor,
            after: None,
            backoff: HashMap::new(),
            queue_window: false,
            wake: None,
            paused: None,
            digest_checked: None,
            tracker_mail: None,
            scan_in_progress: None,
            timeout_retry: None,
            thread_ask_refusal: None,
            #[cfg(test)]
            test_scan_delay: None,
            #[cfg(test)]
            test_trigger_delay: None,
        }
    }
    pub(crate) fn with_tracker_mail(
        mut self,
        runtime: Arc<crate::tracker_mail_runtime::TrackerMailRuntime>,
    ) -> Self {
        self.tracker_mail = Some(runtime);
        self
    }
    /// Defer every fire while `paused` answers true (deploy drain).
    pub fn with_pause(mut self, paused: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.paused = Some(paused);
        self
    }
    /// Queue a Deep window intent with every admitted occurrence and wake the
    /// dispatcher. Only the trusted server composition selects this.
    pub fn with_window_dispatch(mut self, wake: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.queue_window = true;
        self.wake = Some(wake);
        self
    }
    /// Test hook: make the next pass check for due digests regardless of spacing.
    #[cfg(test)]
    pub(crate) fn check_digests_next_pass(&mut self) {
        self.digest_checked = None;
    }
    /// One bounded page; cursor is process-local fairness metadata, never authority.
    pub async fn tick(&mut self) -> Result<DurableTick, HistoryError> {
        if self.paused.as_ref().is_some_and(|paused| paused()) {
            return Ok(DurableTick::default());
        }
        if self.timeout_retry.is_some_and(|at| at > Instant::now()) {
            return Ok(DurableTick {
                deferred: 1,
                ..Default::default()
            });
        }
        match tokio::time::timeout(Duration::from_secs(5), self.pass()).await {
            Ok(result) => result,
            Err(_) => {
                self.timeout_retry = Some(Instant::now() + RETRY_BASE);
                if let Some(namespace) = self.scan_in_progress.take() {
                    self.hold(namespace, Instant::now());
                    self.alert(namespace, "tracker_scan_pass_timed_out");
                    self.after = Some(namespace);
                } else {
                    // A scan may already have committed before triggers/digests
                    // exhausted this pass. Report no withdrawal or delivery.
                    eprintln!(
                        "{}",
                        serde_json::json!({"event":"timer_controller_pass_timeout","retry_after_ms":5000,"receipts_remain_authoritative":true})
                    );
                }
                Ok(DurableTick {
                    deferred: 1,
                    ..Default::default()
                })
            }
        }
    }
    async fn pass(&mut self) -> Result<DurableTick, HistoryError> {
        // Only occurrences that are due by the Store clock are scanned.
        let candidates = self
            .supervisor
            .due_timer_scheduler_candidates(self.after, PAGE)
            .await?;
        let mut next = next_cursor(&candidates);
        let mut result = DurableTick::default();
        let now = Instant::now();
        for namespace in candidates {
            if self
                .backoff
                .get(&namespace)
                .is_some_and(|(_, retry)| *retry > now)
            {
                result.deferred += 1;
                continue;
            }
            // Fresh issuer every time: discovery/UUID alone never grants admission.
            let issuer = match self.supervisor.authorize_timer_scheduler(namespace).await {
                Ok(issuer) => issuer,
                Err(_) => {
                    self.hold(namespace, now);
                    self.alert(namespace, "timer_issuer_refused");
                    result.deferred += 1;
                    continue;
                }
            };
            result.scanned += 1;
            let kind = self.supervisor.timer_work_kind(&issuer, namespace).await;
            let scan = matches!(kind, Ok(TimerWorkKind::TrackerScan));
            if scan {
                self.scan_in_progress = Some(namespace);
            }
            let admission = match kind {
                Ok(TimerWorkKind::Instruction) => self
                    .supervisor
                    .admit_authorized_timer_turn(&issuer, namespace, self.queue_window)
                    .await
                    .map(|r| !r.duplicate),
                Ok(TimerWorkKind::TrackerScan) => match &self.tracker_mail {
                    Some(runtime) => {
                        let result = runtime
                            .run(&self.supervisor, &issuer, namespace)
                            .await
                            .map(|_| true);
                        #[cfg(test)]
                        if let Some(delay) = self.test_scan_delay.take() {
                            tokio::time::sleep(delay).await;
                        }
                        result
                    }
                    None => {
                        self.alert(namespace, "tracker_reader_not_configured");
                        Err(HistoryError::Conflict)
                    }
                },
                Err(_) => {
                    self.alert(namespace, "timer_work_kind_refused");
                    self.hold(namespace, now);
                    result.deferred += 1;
                    continue;
                }
            };
            match admission {
                Ok(fresh) => {
                    self.backoff.remove(&namespace);
                    if scan {
                        result.tracker_actions += 1;
                    } else if fresh {
                        result.admitted += 1;
                    }
                }
                // Concurrently disabled/stopped, Stop boundary changed or the
                // window queue is full: hold with backoff, recreate nothing.
                Err(_) if scan => {
                    self.hold(namespace, now);
                    self.alert(namespace, "tracker_scan_failed_occurrence_held");
                    result.deferred += 1;
                }
                Err(
                    HistoryError::Conflict | HistoryError::NotFound | HistoryError::Unavailable,
                ) => {
                    self.hold(namespace, now);
                    result.deferred += 1;
                }
                Err(error) => return Err(error),
            }
            // At most one bounded I/O wait per five-second pass. Rotate after
            // this namespace even if the read is held, so other work stays fair.
            if scan {
                self.scan_in_progress = None;
                next = Some(namespace);
                break;
            }
            // Issuer drops here; no instruction or credential is retained locally.
        }
        self.after = next;
        self.triggers(&mut result, now).await?;
        if self
            .digest_checked
            .is_none_or(|at| at.elapsed() >= DIGEST_CHECK)
        {
            result.digests = self.supervisor.generate_timer_digests().await?;
            self.digest_checked = Some(Instant::now());
        }
        let mut asked = false;
        match self.supervisor.advance_thread_asks(self.queue_window).await {
            Ok(tick) => {
                result.thread_asks = tick.queued + tick.settled + tick.returned;
                asked = tick.queued + tick.returned > 0;
                self.thread_ask_refusal = None;
            }
            // Never stops timers: requests stay durable and retry next pass.
            Err(error) => {
                let reason = format!("{error:?}");
                if self.thread_ask_refusal.as_deref() != Some(reason.as_str()) {
                    eprintln!(
                        "{}",
                        serde_json::json!({"event":"thread_ask_pass_refused","reason":reason,"requests_remain_durable":true})
                    );
                    self.thread_ask_refusal = Some(reason);
                }
            }
        }
        if result.admitted + result.triggered > 0 || asked {
            if let Some(wake) = &self.wake {
                wake();
            }
        }
        Ok(result)
    }
    fn hold(&mut self, namespace: Uuid, now: Instant) {
        let failures = self
            .backoff
            .get(&namespace)
            .map_or(1, |(n, _)| n.saturating_add(1));
        self.backoff
            .insert(namespace, (failures, now + retry_delay(failures)));
    }
    fn alert(&self, namespace: Uuid, reason: &'static str) {
        if let Some(runtime) = &self.tracker_mail {
            runtime.alert(namespace, reason);
        } else {
            eprintln!(
                "{}",
                serde_json::json!({"event":"timer_work_refused","namespace":namespace,"reason":reason,"occurrence_held":true})
            );
        }
    }
    /// Runs for recorded inbound events (new message or email). Same fresh
    /// issuer, backoff and window queue as clock occurrences.
    async fn triggers(
        &mut self,
        result: &mut DurableTick,
        now: Instant,
    ) -> Result<(), HistoryError> {
        #[cfg(test)]
        if let Some((delay, started)) = self.test_trigger_delay.take() {
            started.store(true, std::sync::atomic::Ordering::Relaxed);
            tokio::time::sleep(delay).await;
        }
        for namespace in self
            .supervisor
            .pending_timer_trigger_namespaces(PAGE)
            .await?
        {
            if self
                .backoff
                .get(&namespace)
                .is_some_and(|(_, retry)| *retry > now)
            {
                continue;
            }
            let issuer = match self.supervisor.authorize_timer_scheduler(namespace).await {
                Ok(issuer) => issuer,
                Err(_) => {
                    self.hold(namespace, now);
                    self.alert(namespace, "trigger_issuer_refused");
                    result.deferred += 1;
                    continue;
                }
            };
            match self.supervisor.timer_work_kind(&issuer, namespace).await {
                Ok(TimerWorkKind::Instruction) => {}
                Ok(TimerWorkKind::TrackerScan) | Err(_) => {
                    self.alert(namespace, "trigger_action_kind_refused");
                    let failures = self.backoff.get(&namespace).map_or(0, |(n, _)| *n) + 1;
                    self.backoff
                        .insert(namespace, (failures, now + retry_delay(failures)));
                    result.deferred += 1;
                    continue;
                }
            }
            match self
                .supervisor
                .admit_authorized_trigger_turn(&issuer, namespace, self.queue_window)
                .await
            {
                Ok(admitted) => {
                    self.backoff.remove(&namespace);
                    result.triggered += u32::from(admitted.is_some_and(|r| !r.duplicate));
                }
                Err(
                    HistoryError::Conflict | HistoryError::NotFound | HistoryError::Unavailable,
                ) => {
                    let failures = self.backoff.get(&namespace).map_or(0, |(n, _)| *n) + 1;
                    self.backoff
                        .insert(namespace, (failures, now + retry_delay(failures)));
                    result.deferred += 1;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
    /// No runtime registration here. Caller must join this future on shutdown.
    /// Auth/context failure terminates; trusted bootstrap must provide a fresh context.
    pub async fn run(
        mut self,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), HistoryError> {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Refresh a still-current session at startup too; a session may be near
        // expiry when an operator restarts the trusted service. Never resurrect it.
        self.supervisor
            .renew_timer_supervisor_credential()
            .await
            .map_err(|_| HistoryError::Unauthorized)?;
        let mut renewal = tokio::time::Instant::now();
        loop {
            if *shutdown.borrow() {
                return self
                    .supervisor
                    .retire_timer_supervisor()
                    .await
                    .map_err(|_| HistoryError::Unauthorized);
            }
            tokio::select! {
                changed=shutdown.changed()=>{if changed.is_err() || *shutdown.borrow(){return self.supervisor.retire_timer_supervisor().await.map_err(|_| HistoryError::Unauthorized);}},
                _=interval.tick()=>{
                    self.supervisor.heartbeat_supervisor().await.map_err(|_| HistoryError::Unauthorized)?;
                    if renewal.elapsed() >= Duration::from_secs(3600) {
                        self.supervisor.renew_timer_supervisor_credential().await.map_err(|_| HistoryError::Unauthorized)?;
                        renewal = tokio::time::Instant::now();
                    }
                    self.tick().await?;
                }
            }
        }
    }
}
fn next_cursor(page: &[Uuid]) -> Option<Uuid> {
    if page.len() == usize::from(PAGE) {
        page.last().copied()
    } else {
        None
    }
}
#[cfg(test)]
#[path = "durable_tests.rs"]
mod tests;
