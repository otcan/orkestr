//! One live channel's watch loop, shared by both transports. It re-reads the
//! watched paths shortly after a committed change (and periodically, for
//! answers that depend on state outside the store), pushes the paths whose
//! fingerprint changed, sends a heartbeat every 12 s, re-checks the browser
//! session with each heartbeat and ends on a lifetime limit, a replacement or
//! a closed transport.
use super::protocol::{ClientFrame, Fingerprint, Frame, HEARTBEAT};
use super::watch::{self, Answer};
use super::{Hub, Opening};
use crate::{observability::Observer, AppState};
use axum::Router;
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch as signal};

/// A committed change is read this long after its signal, so that the
/// commit is visible and a burst of commits costs one read.
const DEBOUNCE: Duration = Duration::from_millis(150);
/// One more read this long after the last change of a burst.
const SETTLE: Duration = Duration::from_secs(1);
/// A path is read at most once per this multiple of its last read time...
const COST_FACTOR: u32 = 40;
/// ...and at most every 2 s (the old fastest poll), and never less often
/// than its floor. The first change after a quiet spell is read at once.
const MIN_INTERVAL: Duration = Duration::from_secs(2);
const MAX_INTERVAL: Duration = Duration::from_secs(15);
/// Reads run one after another; a stuck read ends after this.
const READ_TIMEOUT: Duration = Duration::from_secs(12);
/// A change this recent when a path starts being watched may have happened
/// between the browser's own read and the server's first one.
const RECENT: Duration = Duration::from_secs(5);
/// Read time a channel may spend per second of wall time (a store that is
/// written all the time costs a channel at most 5 % of one core)...
const BUDGET_RATE: f64 = 0.05;
/// ...after a burst of at most this much (a first read of every path).
const BUDGET_CAP: f64 = 1.5;

/// Read time a channel may still spend, in seconds; negative: owed.
struct Budget {
    seconds: f64,
    at: Instant,
}

impl Budget {
    fn new() -> Self {
        Self {
            seconds: BUDGET_CAP,
            at: Instant::now(),
        }
    }
    fn refill(&mut self, now: Instant) {
        let gained = now.saturating_duration_since(self.at).as_secs_f64() * BUDGET_RATE;
        self.seconds = (self.seconds + gained).min(BUDGET_CAP);
        self.at = now;
    }
    fn spend(&mut self, elapsed: Duration) {
        self.seconds -= elapsed.as_secs_f64();
    }
    /// When reading may resume (now, unless time is owed).
    fn ready_at(&self) -> Instant {
        if self.seconds >= 0.0 {
            self.at
        } else {
            self.at + Duration::from_secs_f64(-self.seconds / BUDGET_RATE)
        }
    }
}

struct Watched {
    answer: Option<Answer>,
    floor: Duration,
    read_at: Option<Instant>,
    cost: Duration,
    /// A read is due no earlier than this (a change was signalled).
    pending: Option<Instant>,
    /// One more read after the last change of a burst.
    settle: Option<Instant>,
}

impl Watched {
    fn new(floor: Duration) -> Self {
        Self {
            answer: None,
            floor,
            read_at: None,
            cost: Duration::ZERO,
            pending: Some(Instant::now()),
            settle: None,
        }
    }
    fn min_interval(&self) -> Duration {
        (self.cost * COST_FACTOR).clamp(MIN_INTERVAL, MAX_INTERVAL.min(self.floor))
    }
    /// When this path should next be read.
    fn due(&self) -> Instant {
        let Some(read_at) = self.read_at else {
            return self.pending.unwrap_or_else(Instant::now);
        };
        let earliest = read_at + self.min_interval();
        [self.pending, self.settle]
            .into_iter()
            .flatten()
            .map(|at| at.max(earliest))
            .chain([read_at + self.floor])
            .min()
            .unwrap_or(read_at + self.floor)
    }
}

pub(crate) struct Session {
    state: AppState,
    hub: Arc<Hub>,
    opening: Opening,
    router: Router,
    watched: BTreeMap<String, Watched>,
    budget: Budget,
}

/// Why a session ended (the metric `orkestr_v2_live_closed_total` reason).
pub(crate) type Reason = &'static str;

impl Session {
    pub(crate) fn new(state: AppState, hub: Arc<Hub>, opening: Opening) -> Self {
        // The same API the browser polls, without the outer observing layer:
        // fingerprint reads are not browser requests and never count as such.
        let router = crate::router(state.clone());
        Self {
            state,
            hub,
            opening,
            router,
            watched: BTreeMap::new(),
            budget: Budget::new(),
        }
    }

    async fn send(out: &mpsc::Sender<Frame>, frame: Frame) -> Result<(), Reason> {
        out.send(frame).await.map_err(|_| "write_error")
    }

    /// Adds and removes watched paths; answers what was refused.
    async fn update(
        &mut self,
        add: Vec<String>,
        remove: Vec<String>,
        out: &mpsc::Sender<Frame>,
    ) -> Result<(), Reason> {
        for path in remove {
            self.watched.remove(&path);
        }
        for path in add {
            if self.watched.contains_key(&path) {
                continue;
            }
            let refusal = match watch::floor(&path) {
                None => Some("not_watchable"),
                Some(_) if self.watched.len() >= watch::MAX_PATHS => Some("limit"),
                Some(floor) => {
                    self.watched.insert(path.clone(), Watched::new(floor));
                    None
                }
            };
            if let Some(reason) = refusal {
                let path = path.chars().take(watch::MAX_PATH_LEN).collect();
                Self::send(out, Frame::Refused { path, reason }).await?;
            }
        }
        Ok(())
    }

    fn signal(&mut self) {
        let now = Instant::now();
        for watched in self.watched.values_mut() {
            let at = now + DEBOUNCE;
            watched.pending = Some(watched.pending.map_or(at, |p| p.min(at)));
            watched.settle = Some(now + SETTLE);
        }
    }

    fn next_due(&self) -> Option<Instant> {
        let due = self.watched.values().map(Watched::due).min()?;
        Some(due.max(self.budget.ready_at()))
    }

    /// Reads every due path; returns the new and the changed fingerprints.
    async fn read_due(&mut self) -> (Vec<Fingerprint>, Vec<Fingerprint>) {
        let now = Instant::now();
        let due: Vec<String> = self
            .watched
            .iter()
            .filter(|(_, w)| w.due() <= now)
            .map(|(p, _)| p.clone())
            .collect();
        let (mut first, mut changed) = (Vec::new(), Vec::new());
        let metrics = &Observer::global().metrics.live;
        self.budget.refill(now);
        for path in due {
            // Out of read time: the rest stays due for the next round.
            if self.budget.seconds < -0.001 {
                break;
            }
            let _permit = self.hub.reads.acquire().await;
            let started = Instant::now();
            let answer = tokio::time::timeout(
                READ_TIMEOUT,
                watch::read(&self.router, &self.opening.headers, &path),
            )
            .await
            .ok()
            .flatten();
            let elapsed = started.elapsed();
            metrics.read(elapsed);
            self.budget.spend(elapsed);
            let Some(watched) = self.watched.get_mut(&path) else {
                continue;
            };
            watched.cost = elapsed;
            watched.read_at = Some(started);
            watched.pending = None;
            if watched.settle.is_some_and(|at| at <= started) {
                watched.settle = None;
            }
            // An unreadable answer keeps the last fingerprint.
            let Some(answer) = answer else { continue };
            let fingerprint = Fingerprint {
                path: path.clone(),
                fp: answer.fp.clone(),
            };
            match &watched.answer {
                None => first.push(fingerprint),
                Some(previous) if previous.fp != answer.fp => changed.push(fingerprint),
                Some(_) => {}
            }
            watched.answer = Some(answer);
        }
        (first, changed)
    }

    /// Runs until the browser leaves, the session ends or the server closes
    /// the channel. Returns the close reason.
    pub(crate) async fn run(
        mut self,
        mut inbound: mpsc::Receiver<ClientFrame>,
        out: mpsc::Sender<Frame>,
        mut closing: signal::Receiver<Option<Reason>>,
    ) -> Reason {
        let metrics = &Observer::global().metrics.live;
        let mut changes = self.state.store.changes().subscribe();
        changes.borrow_and_update();
        let started = Instant::now();
        let lifetime = started + self.opening.lifetime;
        let mut heartbeat = tokio::time::interval_at(
            tokio::time::Instant::from_std(started + HEARTBEAT),
            HEARTBEAT,
        );
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let hello = Frame::Hello {
            v: super::protocol::PROTOCOL,
            channel: self.opening.channel.clone(),
            transport: self.opening.transport,
            heartbeat_ms: HEARTBEAT.as_millis() as u64,
            max_paths: watch::MAX_PATHS,
        };
        if let Err(reason) = Self::send(&out, hello).await {
            return reason;
        }
        let initial = std::mem::take(&mut self.opening.paths);
        if let Err(reason) = self.update(initial, Vec::new(), &out).await {
            return reason;
        }
        loop {
            let due = self
                .next_due()
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
            tokio::select! {
                biased;
                _ = closing.changed() => {
                    let reason = closing.borrow().unwrap_or("shutdown");
                    let _ = Self::send(&out, Frame::Bye { reason }).await;
                    return reason;
                }
                frame = inbound.recv() => match frame {
                    None => return "client",
                    Some(ClientFrame::Watch { add, remove }) => {
                        if let Err(reason) = self.update(add, remove, &out).await {
                            return reason;
                        }
                    }
                    Some(ClientFrame::Report { fallback_polls, reconnects }) => {
                        metrics.reported(fallback_polls, reconnects);
                    }
                    Some(ClientFrame::Hb {}) => {}
                },
                changed = changes.changed() => {
                    if changed.is_err() {
                        let _ = Self::send(&out, Frame::Bye { reason: "shutdown" }).await;
                        return "shutdown";
                    }
                    changes.borrow_and_update();
                    self.signal();
                }
                _ = heartbeat.tick() => {
                    if crate::browser::owner(&self.state, &self.opening.headers).await.is_err() {
                        let _ = Self::send(&out, Frame::Expired {}).await;
                        return "expired";
                    }
                    let at_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |d| d.as_millis() as i64);
                    if let Err(reason) = Self::send(&out, Frame::Hb { at_ms }).await {
                        return reason;
                    }
                }
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(lifetime)) => {
                    let _ = Self::send(&out, Frame::Bye { reason: "lifetime" }).await;
                    return "lifetime";
                }
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(due)) => {
                    let (first, changed) = self.read_due().await;
                    if !first.is_empty() {
                        // A change moments before the first read may postdate
                        // the browser's own read: say so, it refetches once.
                        let recent = self
                            .state
                            .store
                            .changes()
                            .quiet_for()
                            .is_some_and(|quiet| quiet < RECENT);
                        let frame = Frame::Watching { paths: first, recent };
                        if let Err(reason) = Self::send(&out, frame).await {
                            return reason;
                        }
                    }
                    if !changed.is_empty() {
                        metrics.invalidated(changed.len());
                        if let Err(reason) = Self::send(&out, Frame::Changed { paths: changed }).await {
                            return reason;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_busy_store_costs_a_channel_a_bounded_share_of_read_time() {
        let mut budget = Budget::new();
        let start = budget.at;
        assert_eq!(budget.ready_at(), start);
        budget.spend(Duration::from_secs(2));
        // 0.5 s owed at 5 % of wall time: ten seconds until the next read.
        let wait = budget.ready_at().duration_since(start);
        assert!(wait.abs_diff(Duration::from_secs(10)) < Duration::from_millis(1));
        budget.refill(start + Duration::from_secs(10));
        assert!(budget.seconds.abs() < 1e-9);
        budget.refill(start + Duration::from_secs(1000));
        assert!((budget.seconds - BUDGET_CAP).abs() < 1e-9);
    }

    #[test]
    fn reads_are_debounced_rate_limited_and_floored() {
        let floor = Duration::from_secs(30);
        let mut watched = Watched::new(floor);
        // A new path is read at once.
        assert!(watched.due() <= Instant::now());
        let read = Instant::now();
        watched.read_at = Some(read);
        watched.pending = None;
        watched.cost = Duration::from_millis(5);
        // Without a change only the floor brings the next read.
        assert_eq!(watched.due(), read + floor);
        // A change is read after the debounce, but not before the minimum
        // interval since the last read.
        watched.pending = Some(read + Duration::from_millis(10));
        assert_eq!(watched.due(), read + MIN_INTERVAL);
        // An expensive read is repeated less often.
        watched.cost = Duration::from_millis(270);
        assert_eq!(
            watched.due(),
            read + Duration::from_millis(270) * COST_FACTOR
        );
        watched.cost = Duration::from_secs(5);
        assert_eq!(watched.due(), read + MAX_INTERVAL);
        // The settle read comes after the burst, no sooner than the minimum.
        watched.cost = Duration::from_millis(5);
        watched.pending = None;
        watched.settle = Some(read + MIN_INTERVAL + SETTLE);
        assert_eq!(watched.due(), read + MIN_INTERVAL + SETTLE);
        watched.settle = Some(read + SETTLE);
        assert_eq!(watched.due(), read + MIN_INTERVAL);
        // A short floor caps the interval.
        let mut v1 = Watched::new(Duration::from_secs(10));
        v1.read_at = Some(read);
        v1.pending = Some(read);
        v1.cost = Duration::from_secs(1);
        assert_eq!(v1.due(), read + Duration::from_secs(10));
    }
}
