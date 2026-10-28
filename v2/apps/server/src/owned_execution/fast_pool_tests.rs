//! Deterministic scheduler checks with a synthetic window (no provider).
use super::*;
use orkestr_v2_contracts::{ConversationId, EventId, MessageId, OwnerId};
use std::collections::HashSet;
use std::sync::{atomic::AtomicBool, Mutex};

struct Burst {
    companion: Arc<Companion>,
    sources: Vec<FastSource>,
    /// Durable admission: Core never selects a presented source again.
    presented: Mutex<HashSet<EventId>>,
    starts: Mutex<Vec<(EventId, Instant)>>,
    finishes: Mutex<Vec<(EventId, Instant)>>,
    closing: AtomicBool,
    headroom: AtomicBool,
    /// The owner's kill switch (`parallel_replies`).
    parallel: AtomicBool,
    work: Duration,
    fail: Option<EventId>,
    setup_fail: Option<EventId>,
    setup_attempts: AtomicUsize,
    cancelled: AtomicUsize,
    /// Store errors the next eligibility reads return, in order.
    store_errors: Mutex<std::collections::VecDeque<RuntimeStoreError>>,
    /// Every read fails with this error (a persistent Store fault).
    store_down: Option<RuntimeStoreError>,
    reads: AtomicUsize,
    retry_budget: Duration,
    _directory: Directory,
}

struct Directory(std::path::PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Burst {
    async fn new(messages: usize, work: Duration) -> Arc<Self> {
        let directory = std::env::temp_dir().join(format!("fast-pool-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let store = orkestr_v2_store_sqlite::Store::open(&directory.join("core.sqlite3"))
            .await
            .unwrap();
        let companion = Companion::new(crate::execution_registry::ExecutionScope {
            store,
            control: Some(crate::control_registry::ControlRegistry::new(
                OwnerId(uuid::Uuid::new_v4()),
                ConversationId(uuid::Uuid::new_v4()),
            )),
            tasks: None,
        });
        Arc::new(Self {
            companion,
            sources: (1..=messages)
                .map(|n| FastSource {
                    message_id: MessageId(uuid::Uuid::new_v4()),
                    event_id: EventId(uuid::Uuid::new_v4()),
                    sequence: n as i64,
                })
                .collect(),
            presented: Mutex::new(HashSet::new()),
            starts: Mutex::new(Vec::new()),
            finishes: Mutex::new(Vec::new()),
            closing: AtomicBool::new(false),
            headroom: AtomicBool::new(true),
            parallel: AtomicBool::new(true),
            work,
            fail: None,
            setup_fail: None,
            setup_attempts: AtomicUsize::new(0),
            cancelled: AtomicUsize::new(0),
            store_errors: Mutex::new(std::collections::VecDeque::new()),
            store_down: None,
            reads: AtomicUsize::new(0),
            retry_budget: crate::owned_execution::fast_eligibility::RETRY_BUDGET,
            _directory: Directory(directory),
        })
    }

    fn admit(&self, source: &FastSource) {
        assert!(
            self.presented
                .lock()
                .unwrap()
                .insert(source.event_id.clone()),
            "one presentation per owner input"
        );
        self.starts
            .lock()
            .unwrap()
            .push((source.event_id.clone(), Instant::now()));
    }

    /// The canonical lineage: presents the first input, then stays busy
    /// with it until the window closes.
    fn lineage(
        self: &Arc<Self>,
    ) -> impl Future<Output = Result<(), &'static str>> + Send + 'static {
        let this = self.clone();
        assert!(this.companion.claim_ready());
        assert!(this.companion.claim_start());
        async move {
            let first = this.sources[0].clone();
            assert!(this.companion.claim_source(&first.event_id));
            this.admit(&first);
            this.companion.started();
            while !this.closing() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            Ok(())
        }
    }

    fn started(&self) -> usize {
        self.starts.lock().unwrap().len()
    }

    async fn wait_started(&self, count: usize, within: Duration) -> Duration {
        let begin = Instant::now();
        while self.started() < count {
            assert!(
                begin.elapsed() < within,
                "only {} of {count} started",
                self.started()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        begin.elapsed()
    }
}

impl SlotHost for Burst {
    fn companion(&self) -> &Companion {
        &self.companion
    }
    fn closing(&self) -> bool {
        self.closing.load(Ordering::Acquire)
    }
    fn admit_one(&self) -> bool {
        self.headroom.load(Ordering::Acquire)
    }
    async fn extra_slots_enabled(&self) -> bool {
        self.parallel.load(Ordering::Acquire)
    }
    fn eligibility_retry(&self) -> TransientRetry {
        TransientRetry::with_budget(self.retry_budget)
    }
    async fn next_source(&self) -> Result<Option<FastSource>, RuntimeStoreError> {
        self.reads.fetch_add(1, Ordering::AcqRel);
        if let Some(error) = self.store_down {
            return Err(error);
        }
        if let Some(error) = self.store_errors.lock().unwrap().pop_front() {
            return Err(error);
        }
        // Core's earliest-unpresented order, stepping over claimed inputs.
        let presented = self.presented.lock().unwrap().clone();
        Ok(self
            .sources
            .iter()
            .find(|source| {
                !presented.contains(&source.event_id)
                    && !self.companion.is_claimed(&source.event_id)
            })
            .cloned())
    }
    async fn present(self: Arc<Self>, source: FastSource) -> Result<SlotEnd, &'static str> {
        // Setup of a fresh native, then admission of exactly this input.
        tokio::time::sleep(Duration::from_millis(20)).await;
        if self.setup_fail.as_ref() == Some(&source.event_id) {
            self.setup_attempts.fetch_add(1, Ordering::AcqRel);
            return Ok(SlotEnd::SetupFailed("synthetic slot setup refusal"));
        }
        self.admit(&source);
        if self.fail.as_ref() == Some(&source.event_id) {
            return Err("synthetic slot refusal");
        }
        let deadline = Instant::now() + self.work;
        while Instant::now() < deadline {
            if self.closing() {
                // Window work deadline: the slot's run is cancelled and reaped.
                self.cancelled.fetch_add(1, Ordering::AcqRel);
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        self.finishes
            .lock()
            .unwrap()
            .push((source.event_id.clone(), Instant::now()));
        Ok(SlotEnd::Presented(None))
    }
}

fn channel() -> (watch::Sender<bool>, watch::Receiver<bool>) {
    watch::channel(false)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn burst_of_nine_starts_concurrently_each_bound_to_its_own_input() {
    let burst = Burst::new(9, Duration::from_millis(600)).await;
    let (_stop, shutdown) = channel();
    let pool = tokio::spawn(schedule(burst.clone(), burst.lineage(), shutdown));
    // The lineage plus seven slots: eight presentations at once, not serial.
    burst.wait_started(8, Duration::from_secs(2)).await;
    let starts = burst.starts.lock().unwrap().clone();
    let first = starts.iter().map(|(_, at)| *at).min().unwrap();
    let last = starts.iter().map(|(_, at)| *at).max().unwrap();
    assert!(
        last.duration_since(first) < Duration::from_millis(400),
        "eight starts spread over {:?}",
        last.duration_since(first)
    );
    assert_eq!(burst.companion.active_slots(), 7);
    // The ninth starts as soon as one slot is free (per-window ceiling 8).
    burst.wait_started(9, Duration::from_secs(3)).await;
    let ninth = burst.starts.lock().unwrap()[8].1;
    let earliest_finish = burst
        .finishes
        .lock()
        .unwrap()
        .iter()
        .map(|(_, at)| *at)
        .min()
        .unwrap();
    assert!(ninth >= earliest_finish);
    assert!(ninth.duration_since(earliest_finish) < Duration::from_millis(400));
    // Every owner input was presented exactly once, by its own task.
    let presented: HashSet<_> = burst
        .starts
        .lock()
        .unwrap()
        .iter()
        .map(|(e, _)| e.clone())
        .collect();
    let expected: HashSet<_> = burst.sources.iter().map(|s| s.event_id.clone()).collect();
    assert_eq!(presented, expected);
    while burst.finishes.lock().unwrap().len() < 8 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    burst.closing.store(true, Ordering::Release);
    pool.await.unwrap().unwrap();
    assert_eq!(burst.companion.active_slots(), 0);
    // Admitted inputs stay claimed for the window's life.
    assert!(burst.companion.is_claimed(&burst.sources[8].event_id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn window_close_cancels_every_slot_and_drain_waits_for_all() {
    let burst = Burst::new(9, Duration::from_secs(60)).await;
    let (_stop, shutdown) = channel();
    let pool = tokio::spawn(schedule(burst.clone(), burst.lineage(), shutdown));
    burst.wait_started(8, Duration::from_secs(2)).await;
    burst.closing.store(true, Ordering::Release);
    tokio::time::timeout(Duration::from_secs(5), pool)
        .await
        .expect("drain completes")
        .unwrap()
        .unwrap();
    // Returned only after every started slot finished its own close.
    assert_eq!(burst.cancelled.load(Ordering::Acquire), 7);
    assert_eq!(burst.finishes.lock().unwrap().len(), 7);
    assert_eq!(burst.companion.active_slots(), 0);
    // Nothing new started during close; the ninth input stays for later.
    assert_eq!(burst.started(), 8);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_drains_slots_and_retirement_starts_none() {
    let burst = Burst::new(4, Duration::from_millis(200)).await;
    let (stop, shutdown) = channel();
    let pool = tokio::spawn(schedule(burst.clone(), burst.lineage(), shutdown));
    burst.wait_started(4, Duration::from_secs(2)).await;
    // Deep began retirement: no slot may enter after it.
    burst.companion.retire();
    assert!(!burst.companion.enter_slot());
    stop.send(true).unwrap();
    burst.closing.store(true, Ordering::Release);
    pool.await.unwrap().unwrap();
    assert_eq!(burst.companion.active_slots(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_extra_slot_without_host_headroom_or_while_the_lineage_is_idle() {
    let burst = Burst::new(3, Duration::from_millis(100)).await;
    burst.headroom.store(false, Ordering::Release);
    let (_stop, shutdown) = channel();
    let pool = tokio::spawn(schedule(burst.clone(), burst.lineage(), shutdown));
    burst.wait_started(1, Duration::from_secs(2)).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        burst.started(),
        1,
        "pressure keeps Fast at its single lineage"
    );
    // A ready, idle lineage takes the next input itself.
    burst.companion.set_primary_idle(true);
    burst.headroom.store(true, Ordering::Release);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(burst.started(), 1);
    burst.companion.set_primary_idle(false);
    burst.wait_started(3, Duration::from_secs(2)).await;
    burst.closing.store(true, Ordering::Release);
    pool.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slot_failing_after_admission_never_aborts_its_siblings() {
    let mut burst = Burst::new(5, Duration::from_millis(300)).await;
    let failing = burst.sources[2].event_id.clone();
    Arc::get_mut(&mut burst).unwrap().fail = Some(failing);
    let (_stop, shutdown) = channel();
    let pool = tokio::spawn(schedule(burst.clone(), burst.lineage(), shutdown));
    burst.wait_started(5, Duration::from_secs(2)).await;
    // The three healthy slots finish their own runs despite the failure.
    while burst.finishes.lock().unwrap().len() < 3 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // The lineage is still running: the pool waits for it, not aborting it.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!pool.is_finished());
    assert_eq!(burst.companion.active_slots(), 0);
    burst.closing.store(true, Ordering::Release);
    let result = tokio::time::timeout(Duration::from_secs(5), pool)
        .await
        .expect("drain completes")
        .unwrap();
    // The first failure is still reported, after every task closed.
    assert_eq!(result, Err("synthetic slot refusal"));
    assert_eq!(burst.finishes.lock().unwrap().len(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn admitted_inputs_stay_claimed_for_the_window() {
    let burst = Burst::new(3, Duration::from_millis(50)).await;
    let (_stop, shutdown) = channel();
    let pool = tokio::spawn(schedule(burst.clone(), burst.lineage(), shutdown));
    while burst.finishes.lock().unwrap().len() < 2 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // A reader that saw an input before its admission committed can never
    // claim it afterwards: every admitted input is still claimed.
    for source in &burst.sources {
        assert!(burst.companion.is_claimed(&source.event_id));
        assert!(!burst.companion.claim_source(&source.event_id));
    }
    burst.closing.store(true, Ordering::Release);
    pool.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_slot_setup_failure_stays_local_to_that_slot_and_its_input() {
    let mut burst = Burst::new(5, Duration::from_millis(300)).await;
    let failing = burst.sources[2].event_id.clone();
    Arc::get_mut(&mut burst).unwrap().setup_fail = Some(failing.clone());
    let (_stop, shutdown) = channel();
    let pool = tokio::spawn(schedule(burst.clone(), burst.lineage(), shutdown));
    // The lineage and the three healthy slots present; the failed one does not.
    burst.wait_started(4, Duration::from_secs(2)).await;
    while burst.finishes.lock().unwrap().len() < 3 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // Plenty of polls later: the failed input is never retried into the same
    // failure, nothing failed the companion, and slots stay usable.
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(burst.setup_attempts.load(Ordering::Acquire), 1);
    assert!(!burst.presented.lock().unwrap().contains(&failing));
    assert!(burst.companion.is_claimed(&failing));
    assert!(!burst.companion.has_failed());
    assert!(!pool.is_finished());
    assert_eq!(burst.companion.active_slots(), 0);
    burst.closing.store(true, Ordering::Release);
    pool.await.unwrap().unwrap();
    assert_eq!(burst.started(), 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lineage_keeps_its_held_input_across_rotation() {
    let burst = Burst::new(2, Duration::from_millis(10)).await;
    let companion = &burst.companion;
    let event = burst.sources[0].event_id.clone();
    // Only a claimed input can be held.
    companion.hold_for_lineage(&event);
    assert!(!companion.lineage_holds(&event));
    assert!(companion.claim_source(&event));
    companion.hold_for_lineage(&event);
    // Still claimed for every other task; the lineage alone may take it.
    assert!(companion.is_claimed(&event));
    assert!(!companion.claim_source(&event));
    assert!(companion.lineage_holds(&event));
    assert!(companion.take_lineage_hold(&event));
    assert!(!companion.take_lineage_hold(&event));
    assert!(
        companion.is_claimed(&event),
        "an admitted input stays claimed"
    );
    companion.hold_for_lineage(&event);
    companion.release_source(&event);
    assert!(!companion.lineage_holds(&event) && !companion.is_claimed(&event));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn owner_kill_switch_keeps_fast_on_slot_zero_and_is_read_live() {
    let burst = Burst::new(3, Duration::from_millis(100)).await;
    burst.parallel.store(false, Ordering::Release);
    let (_stop, shutdown) = channel();
    let pool = tokio::spawn(schedule(burst.clone(), burst.lineage(), shutdown));
    burst.wait_started(1, Duration::from_secs(2)).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        burst.started(),
        1,
        "switch off: slot 0 only, as before slots"
    );
    assert_eq!(burst.companion.active_slots(), 0);
    // Turned back on without a restart: the waiting inputs get extra slots.
    burst.parallel.store(true, Ordering::Release);
    burst.wait_started(3, Duration::from_secs(2)).await;
    burst.closing.store(true, Ordering::Release);
    pool.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn busy_store_twice_then_a_source_keeps_fast_alive() {
    let burst = Burst::new(3, Duration::from_millis(100)).await;
    burst
        .store_errors
        .lock()
        .unwrap()
        .extend([RuntimeStoreError::Busy, RuntimeStoreError::Busy]);
    let (_stop, shutdown) = channel();
    let pool = tokio::spawn(schedule(burst.clone(), burst.lineage(), shutdown));
    // Both waiting inputs still get a slot after the two Busy reads.
    burst.wait_started(3, Duration::from_secs(3)).await;
    assert!(burst.reads.load(Ordering::Acquire) >= 3);
    assert!(burst.companion.eligibility_warned().load(Ordering::Acquire));
    assert!(!pool.is_finished(), "a transient Store error ended Fast");
    burst.closing.store(true, Ordering::Release);
    pool.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn persistent_store_errors_still_end_fast_with_the_same_message() {
    for (error, budget) in [
        (RuntimeStoreError::Busy, Duration::from_millis(400)),
        (RuntimeStoreError::Unavailable, Duration::from_millis(400)),
        // Not transient: no retry at all.
        (RuntimeStoreError::Conflict, Duration::from_secs(600)),
    ] {
        let mut burst = Burst::new(2, Duration::from_millis(50)).await;
        let host = Arc::get_mut(&mut burst).unwrap();
        host.store_down = Some(error);
        host.retry_budget = budget;
        let (_stop, shutdown) = channel();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            schedule(burst.clone(), burst.lineage(), shutdown),
        );
        // The lineage only ends at window close; close it once the pool
        // failed so the drain can complete.
        let closer = {
            let burst = burst.clone();
            tokio::spawn(async move {
                while burst.reads.load(Ordering::Acquire) == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                tokio::time::sleep(budget.min(Duration::from_secs(1)) * 2).await;
                burst.closing.store(true, Ordering::Release);
            })
        };
        assert_eq!(
            result.await.expect("pool ends"),
            Err("Fast input eligibility unavailable"),
            "{error:?}"
        );
        closer.await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cores_deadline_fence_before_the_local_clock_closes_fast_cleanly() {
    // Core fences every read from its work deadline on; the local window
    // clock reaches the same deadline a moment later.
    let mut burst = Burst::new(3, Duration::from_secs(60)).await;
    Arc::get_mut(&mut burst).unwrap().store_down = Some(RuntimeStoreError::Fenced);
    let (_stop, shutdown) = channel();
    let pool = tokio::spawn(schedule(burst.clone(), burst.lineage(), shutdown));
    while burst.reads.load(Ordering::Acquire) == 0 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!pool.is_finished(), "Core's deadline fence ended Fast");
    burst.closing.store(true, Ordering::Release);
    tokio::time::timeout(Duration::from_secs(5), pool)
        .await
        .expect("pool ends")
        .unwrap()
        .expect("a deadline fence is the window closing, not a Fast failure");
    assert!(!burst.companion.eligibility_warned().load(Ordering::Acquire));
}
