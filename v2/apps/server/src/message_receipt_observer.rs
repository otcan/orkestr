//! Bounded, read-only V1 receipt observation. Core times do not wait for V1.
//! Recorded terminal receipts remain historical facts, not fresh observations.
use crate::{desktop_broker::Broker, sidebar_v1::export_receipts};
use orkestr_v2_contracts::{ConversationId, MessageReceipt, MessageReceiptKind, OwnerId};
use std::{
    collections::{HashMap, VecDeque},
    hash::{Hash, Hasher},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{watch, Mutex, Semaphore};

type Receipts = HashMap<String, Vec<MessageReceipt>>;
const KEYS: usize = 64;
const IN_FLIGHT: usize = 4;
const CONFIRMED_EVENTS: usize = 1024;
const FRESH: Duration = Duration::from_secs(1);
const WAIT: Duration = Duration::from_millis(75);
const FETCH: Duration = Duration::from_millis(1500);

// Keeping the Arc in the key prevents identity reuse after broker replacement.
#[derive(Clone)]
struct Key {
    owner: String,
    conversation: String,
    thread: String,
    broker: Arc<Broker>,
}
impl PartialEq for Key {
    fn eq(&self, other: &Self) -> bool {
        self.owner == other.owner
            && self.conversation == other.conversation
            && self.thread == other.thread
            && Arc::ptr_eq(&self.broker, &other.broker)
    }
}
impl Eq for Key {}
impl Hash for Key {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.owner.hash(state);
        self.conversation.hash(state);
        self.thread.hash(state);
        Arc::as_ptr(&self.broker).hash(state);
    }
}

#[derive(Default)]
struct Entry {
    accessed: u64,
    attempted: Option<Instant>,
    latest: Option<(Instant, Receipts)>,
    confirmed: Receipts,
    confirmed_order: VecDeque<String>,
    flight: Option<watch::Receiver<bool>>,
}
fn terminal(receipt: &MessageReceipt) -> bool {
    matches!(
        receipt.kind,
        MessageReceiptKind::SentToWhatsapp
            | MessageReceiptKind::DeliveredInApp
            | MessageReceiptKind::HandedToV1
            | MessageReceiptKind::SuppressedByV1
    )
}
impl Entry {
    fn record(&mut self, sample: Option<Receipts>, now: Instant) {
        self.attempted = Some(now);
        self.latest = sample.map(|sample| {
            for (event, receipts) in &sample {
                let facts: Vec<_> = receipts.iter().filter(|r| terminal(r)).cloned().collect();
                if facts.is_empty() {
                    continue;
                }
                if !self.confirmed.contains_key(event) {
                    if self.confirmed.len() == CONFIRMED_EVENTS {
                        if let Some(oldest) = self.confirmed_order.pop_front() {
                            self.confirmed.remove(&oldest);
                        }
                    }
                    self.confirmed_order.push_back(event.clone());
                }
                let known = self.confirmed.entry(event.clone()).or_default();
                for fact in facts {
                    match known.iter_mut().find(|r| r.kind == fact.kind) {
                        Some(old) if old.at_ms.is_none() => old.at_ms = fact.at_ms,
                        Some(_) => {}
                        None => known.push(fact),
                    }
                }
            }
            (now, sample)
        });
    }
    fn view(&self, now: Instant) -> Receipts {
        let mut result = self
            .latest
            .as_ref()
            .filter(|(at, _)| now.duration_since(*at) < FRESH)
            .map(|(_, receipts)| receipts.clone())
            .unwrap_or_default();
        for (event, known) in &self.confirmed {
            // A later missing/pending sample does not undo an observed ACK.
            // Fresh pending/failed observations remain distinct: a handoff
            // acknowledgement is not a physical WhatsApp send.
            let receipts = result.entry(event.clone()).or_default();
            for fact in known {
                match receipts.iter_mut().find(|r| r.kind == fact.kind) {
                    Some(current) => *current = fact.clone(),
                    None => receipts.push(fact.clone()),
                }
            }
        }
        result
    }
}

#[derive(Default)]
struct State {
    sequence: u64,
    entries: HashMap<Key, Entry>,
}
#[derive(Clone)]
pub(crate) struct Observer {
    state: Arc<Mutex<State>>,
    permits: Arc<Semaphore>,
}
impl Default for Observer {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            permits: Arc::new(Semaphore::new(IN_FLIGHT)),
        }
    }
}

impl Observer {
    /// Caller must validate current owner/link both before and after this await.
    /// No owner-session credential is retained. Reads use only the existing
    /// trusted operator-selected broker, never caller-selected credentials.
    pub(crate) async fn observe(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        thread: &str,
        broker: Arc<Broker>,
    ) -> Receipts {
        let key = Key {
            owner: owner.to_string(),
            conversation: conversation.to_string(),
            thread: thread.to_owned(),
            broker,
        };
        let mut state = self.state.lock().await;
        state.sequence = state.sequence.saturating_add(1);
        let accessed = state.sequence;
        if !state.entries.contains_key(&key) {
            if state.entries.len() == KEYS {
                let oldest = state
                    .entries
                    .iter()
                    .filter(|(_, entry)| entry.flight.is_none())
                    .min_by_key(|(_, entry)| entry.accessed)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    state.entries.remove(&oldest);
                } else {
                    return Receipts::new();
                }
            }
            state.entries.insert(key.clone(), Entry::default());
        }
        let entry = state.entries.get_mut(&key).expect("inserted receipt key");
        entry.accessed = accessed;
        if entry
            .flight
            .as_ref()
            .is_some_and(|receiver| receiver.has_changed().is_err())
        {
            // A failed/aborted task cannot strand its key permanently.
            entry.flight = None;
            entry.attempted = None;
        }
        let now = Instant::now();
        let due = entry
            .attempted
            .is_none_or(|at| now.duration_since(at) >= FRESH);
        if due && entry.flight.is_none() {
            if let Ok(permit) = self.permits.clone().try_acquire_owned() {
                let (finished, receiver) = watch::channel(false);
                entry.flight = Some(receiver);
                let state = self.state.clone();
                let key = key.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let path = format!("/api/threads/{}/messages?limit=200", key.thread);
                    let sample =
                        match tokio::time::timeout(FETCH, key.broker.read(&path, 4 * 1024 * 1024))
                            .await
                        {
                            Ok(Ok((200, value)))
                                if value
                                    .get("messages")
                                    .and_then(serde_json::Value::as_array)
                                    .is_some_and(|rows| rows.len() <= 200) =>
                            {
                                Some(
                                    export_receipts(&value)
                                        .into_iter()
                                        .filter(|(id, receipts)| {
                                            id.len() <= 128 && receipts.len() <= 8
                                        })
                                        .collect(),
                                )
                            }
                            // 204/304, malformed bodies, timeout and failure do not
                            // create a new observation or turn unknown into an ACK.
                            _ => None,
                        };
                    let mut state = state.lock().await;
                    if let Some(entry) = state.entries.get_mut(&key) {
                        entry.record(sample, Instant::now());
                        entry.flight = None;
                    }
                    finished.send_replace(true);
                });
            }
        }
        let receiver = entry.flight.clone();
        if receiver.is_none() {
            return entry.view(now);
        }
        drop(state);
        if let Some(mut receiver) = receiver {
            let _ = tokio::time::timeout(WAIT, receiver.wait_for(|done| *done)).await;
        }
        self.state
            .lock()
            .await
            .entries
            .get(&key)
            .map(|entry| entry.view(Instant::now()))
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_refresh(&self) {
        let flights: Vec<_> = self
            .state
            .lock()
            .await
            .entries
            .values()
            .filter_map(|entry| entry.flight.clone())
            .collect();
        for mut flight in flights {
            let _ = flight.wait_for(|done| *done).await;
        }
    }

    #[cfg(test)]
    pub(crate) async fn expire_observations(&self) {
        for entry in self.state.lock().await.entries.values_mut() {
            entry.attempted = Some(Instant::now() - FRESH);
            if let Some((at, _)) = &mut entry.latest {
                *at = Instant::now() - FRESH;
            }
        }
    }
}

#[cfg(test)]
#[path = "message_receipt_observer_tests.rs"]
mod tests;
