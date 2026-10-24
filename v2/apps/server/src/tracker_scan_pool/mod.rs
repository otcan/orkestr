//! Dedicated bounded mailbox-reader threads. No HTTP, timer or provider admission.
//! Reservations precede Core claims. Dropping a waiter requests cancellation;
//! only actual reader completion releases its custody, including after timeout.
use orkestr_v2_contracts::{ConversationId, OwnerId};
use orkestr_v2_mail_reader::store::{scan_folders, Cursor, ScanFolder, ScanLimits, ScanOutput};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::oneshot;

type Key = (OwnerId, ConversationId);
type Job = Box<dyn FnOnce() + Send>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    Invalid,
    Full,
    Busy,
    Stopping,
    Unavailable,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadFailure {
    Cancelled,
    Unavailable,
    Panicked,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolStatus {
    pub occupied: usize,
    pub active: usize,
    pub queued: usize,
    pub capacity: usize,
    pub stopping: bool,
    pub refusals: u64,
}
struct State {
    occupied: HashMap<Key, Arc<AtomicBool>>,
    active: usize,
    queued: usize,
    capacity: usize,
    stopping: bool,
    refusals: u64,
}
struct Shared(Mutex<State>);
impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Local runtime plumbing, not a serializable read or commit capability.
/// One server retains this pool until `try_join` proves shutdown complete.
pub struct ScanPool {
    shared: Arc<Shared>,
    sender: Mutex<Option<mpsc::SyncSender<Job>>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}
/// A slot and owner/conversation exclusion held before a Core attempt is issued.
pub struct ScanReservation {
    shared: Arc<Shared>,
    key: Key,
    cancel: Arc<AtomicBool>,
}
impl Drop for ScanReservation {
    fn drop(&mut self) {
        self.shared.lock().occupied.remove(&self.key);
    }
}
/// Explicit local selection; never deserialized from an HTTP body.
pub struct ReadRequest {
    pub profile: PathBuf,
    pub folders: Vec<ScanFolder>,
    pub cursor: Cursor,
    pub limits: ScanLimits,
    pub now: SystemTime,
}
/// Hold this through the final Store transaction. Its existence proves the
/// synchronous read returned; it does not prove that the Store accepted a result.
pub struct CompletedScan {
    result: Result<ScanOutput, ReadFailure>,
    _custody: ScanReservation,
}
impl CompletedScan {
    pub fn result(&self) -> Result<&ScanOutput, ReadFailure> {
        self.result.as_ref().map_err(|e| *e)
    }
}
/// The receiver owns cancellation, never reader custody.
pub struct ScanTicket {
    receive: Option<oneshot::Receiver<CompletedScan>>,
    cancel: Arc<AtomicBool>,
    cancel_on_drop: bool,
}
impl Drop for ScanTicket {
    fn drop(&mut self) {
        if self.cancel_on_drop {
            self.cancel.store(true, Ordering::Release);
        }
    }
}
impl ScanTicket {
    /// An expired/dropped waiter leaves the reservation with the actual worker.
    pub async fn wait(
        mut self,
        deadline: tokio::time::Instant,
    ) -> Result<CompletedScan, ReadFailure> {
        let receive = self.receive.take().ok_or(ReadFailure::Unavailable)?;
        let completion = tokio::time::timeout_at(deadline, receive)
            .await
            .map_err(|_| ReadFailure::Cancelled)?
            .map_err(|_| ReadFailure::Unavailable)?;
        self.cancel_on_drop = false;
        Ok(completion)
    }
}

impl ScanPool {
    pub fn new(workers: usize, capacity: usize) -> Result<Self, Refused> {
        if workers == 0 || workers > 4 || capacity < workers || capacity > 16 {
            return Err(Refused::Invalid);
        }
        let (sender, receiver) = mpsc::sync_channel::<Job>(capacity);
        let receiver = Arc::new(Mutex::new(receiver));
        let mut handles = Vec::new();
        for n in 0..workers {
            let receiver = receiver.clone();
            match thread::Builder::new()
                .name(format!("orkestr-mail-reader-{n}"))
                .spawn(move || loop {
                    let job = receiver
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .recv();
                    match job {
                        Ok(job) => job(),
                        Err(_) => break,
                    }
                }) {
                Ok(handle) => handles.push(handle),
                Err(_) => {
                    drop(sender);
                    for handle in handles {
                        let _ = handle.join();
                    }
                    return Err(Refused::Unavailable);
                }
            }
        }
        Ok(Self {
            shared: Arc::new(Shared(Mutex::new(State {
                occupied: HashMap::new(),
                active: 0,
                queued: 0,
                capacity,
                stopping: false,
                refusals: 0,
            }))),
            sender: Mutex::new(Some(sender)),
            workers: Mutex::new(handles),
        })
    }

    pub fn reserve(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<ScanReservation, Refused> {
        if owner.0.is_nil() || conversation.0.is_nil() {
            return Err(Refused::Invalid);
        }
        let mut state = self.shared.lock();
        let key = (owner.clone(), conversation.clone());
        let refused = if state.stopping {
            Some(Refused::Stopping)
        } else if state.occupied.contains_key(&key) {
            Some(Refused::Busy)
        } else if state.occupied.len() >= state.capacity {
            Some(Refused::Full)
        } else {
            None
        };
        if let Some(reason) = refused {
            state.refusals = state.refusals.saturating_add(1);
            return Err(reason);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        state.occupied.insert(key.clone(), cancel.clone());
        Ok(ScanReservation {
            shared: self.shared.clone(),
            key,
            cancel,
        })
    }

    /// Selection and Core fences belong to the caller; this layer bounds I/O.
    pub fn submit(
        &self,
        reservation: ScanReservation,
        mut request: ReadRequest,
    ) -> Result<ScanTicket, Refused> {
        if request.folders.is_empty() || request.folders.len() > 8 {
            return Err(Refused::Invalid);
        }
        request.limits.deadline = request
            .limits
            .deadline
            .min(Instant::now() + Duration::from_secs(5));
        request.limits.max_messages = request.limits.max_messages.min(64);
        request.limits.max_message_bytes = request.limits.max_message_bytes.min(512 * 1024);
        request.limits.max_mbox_bytes = request.limits.max_mbox_bytes.min(8 * 1024 * 1024);
        request.limits.max_seen = request.limits.max_seen.min(100_000);
        self.enqueue(reservation, move || {
            scan_folders(
                &request.profile,
                &request.folders,
                &request.cursor,
                &request.limits,
                request.now,
            )
            .map_err(|_| ReadFailure::Unavailable)
        })
    }

    fn enqueue<F>(&self, reservation: ScanReservation, read: F) -> Result<ScanTicket, Refused>
    where
        F: FnOnce() -> Result<ScanOutput, ReadFailure> + Send + 'static,
    {
        if !Arc::ptr_eq(&self.shared, &reservation.shared) {
            return Err(Refused::Invalid);
        }
        let (send, receive) = oneshot::channel();
        let cancel = reservation.cancel.clone();
        let ticket = ScanTicket {
            receive: Some(receive),
            cancel: cancel.clone(),
            cancel_on_drop: true,
        };
        let shared = self.shared.clone();
        // Lock order is sender then state, matching shutdown. No read is performed under a lock.
        let sender = self
            .sender
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.shared.lock().stopping {
            return Err(Refused::Stopping);
        }
        let sender = sender.as_ref().ok_or(Refused::Stopping)?;
        self.shared.lock().queued += 1;
        let queued = sender.try_send(Box::new(move || {
            {
                let mut state = shared.lock();
                state.queued -= 1;
                state.active += 1;
            }
            let result = if cancel.load(Ordering::Acquire) {
                Err(ReadFailure::Cancelled)
            } else {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(read))
                    .unwrap_or(Err(ReadFailure::Panicked))
            };
            let result = if cancel.load(Ordering::Acquire) {
                Err(ReadFailure::Cancelled)
            } else {
                result
            };
            shared.lock().active -= 1;
            let completion = CompletedScan {
                result,
                _custody: reservation,
            };
            // A closed receiver drops custody here, after the read returned.
            let _ = send.send(completion);
        }));
        if let Err(error) = queued {
            self.shared.lock().queued -= 1;
            drop(error);
            return Err(Refused::Unavailable);
        }
        Ok(ticket)
    }

    pub fn status(&self) -> PoolStatus {
        let state = self.shared.lock();
        PoolStatus {
            occupied: state.occupied.len(),
            active: state.active,
            queued: state.queued,
            capacity: state.capacity,
            stopping: state.stopping,
            refusals: state.refusals,
        }
    }

    /// Requests stop and closes admission; does not assert that any thread exited.
    pub fn begin_shutdown(&self) {
        let mut sender = self
            .sender
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut state = self.shared.lock();
        state.stopping = true;
        for cancel in state.occupied.values() {
            cancel.store(true, Ordering::Release);
        }
        sender.take();
    }

    /// Joins only threads already known finished; a blocked reader returns false.
    pub fn try_join(&self) -> bool {
        let mut workers = self
            .workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut remaining = Vec::new();
        for worker in workers.drain(..) {
            if worker.is_finished() {
                let _ = worker.join();
            } else {
                remaining.push(worker);
            }
        }
        *workers = remaining;
        workers.is_empty() && self.shared.lock().occupied.is_empty()
    }
}
impl Drop for ScanPool {
    fn drop(&mut self) {
        self.begin_shutdown();
        let _ = self.try_join();
    }
}

#[cfg(test)]
mod tests;
