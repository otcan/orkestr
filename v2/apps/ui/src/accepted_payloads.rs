//! Accepted answers read their texts in batches and keep what they read
//! (ORK-797). One request covers many answers, a text on screen is never read
//! again or blanked, and a busy server is retried quietly with backoff.
use crate::accepted_results::bound_payload;
use orkestr_v2_contracts::{
    AcceptedResult, ProviderPayload, ProviderPayloads, PROVIDER_PAYLOAD_BATCH,
};
use std::collections::{BTreeMap, VecDeque};

/// Reads of one batch or one answer before the chat says it could not be loaded.
pub const ATTEMPTS: u32 = 8;
/// A reply that has no text yet shows a loading hint only after this long.
pub const HINT_AFTER_MS: u32 = 3000;
const CACHE_ENTRIES: usize = 1000;
const CACHE_BYTES: usize = 8 * 1024 * 1024;

/// The wait after `failures` failed reads, as a window to pick a random point
/// in: doubling from about one second up to 30 s. The random point keeps many
/// open chats from retrying in step.
pub fn retry_window_ms(failures: u32) -> (u32, u32) {
    let base = (1000_u32 << failures.saturating_sub(1).min(5)).min(30_000);
    (base - base / 4, base + base / 4)
}

/// What one accepted reply shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    /// Nothing read yet.
    Loading,
    /// Its text, or `None` once the text was removed.
    Read(Option<String>),
    /// Every read failed, or the text did not belong to the reply.
    Failed,
}

/// Texts this page has read, for one signed-in session. A removed text
/// (`None`) is never replaced by a later read, like `payload::Output`.
#[derive(Default)]
pub struct PayloadCache {
    generation: u64,
    entries: BTreeMap<(String, String), ProviderPayload>,
    order: VecDeque<(String, String)>,
    bytes: usize,
}

fn key(conversation: &str, payload: &str) -> (String, String) {
    (conversation.to_owned(), payload.to_owned())
}
fn size(payload: &ProviderPayload) -> usize {
    payload.text.as_ref().map_or(0, String::len)
}

impl PayloadCache {
    /// A new session (sign-in, sign-out, expiry) never sees the texts of the last.
    pub fn scope(&mut self, generation: u64) {
        if generation != self.generation {
            *self = Self {
                generation,
                ..Self::default()
            };
        }
    }

    /// The text read for `row`, only if it still belongs to it.
    pub fn get(&self, conversation: &str, row: &AcceptedResult) -> Option<&ProviderPayload> {
        let payload = row.payload_id.as_ref()?.to_string();
        self.entries
            .get(&key(conversation, &payload))
            .filter(|payload| bound_payload(row, conversation, payload))
    }

    /// Keeps a read. Text never comes back once its removal was seen.
    pub fn insert(&mut self, payload: ProviderPayload) {
        let at = key(
            &payload.conversation_id.to_string(),
            &payload.payload_id.to_string(),
        );
        match self.entries.get(&at) {
            Some(old) if old.text.is_none() => return,
            Some(old) => self.bytes -= size(old),
            None => self.order.push_back(at.clone()),
        }
        self.bytes += size(&payload);
        self.entries.insert(at, payload);
        while self.entries.len() > CACHE_ENTRIES || self.bytes > CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(old) = self.entries.remove(&oldest) {
                self.bytes -= size(&old);
            }
        }
    }

    /// The owner removed this text on this page: it is never shown again.
    pub fn removed(&mut self, conversation: &str, payload: &str) {
        if let Some(entry) = self.entries.get_mut(&key(conversation, payload)) {
            self.bytes -= size(entry);
            entry.text = None;
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// The rows whose text is still to be read: one per payload, newest first,
/// without removed or text-less replies.
pub fn wanted(
    conversation: &str,
    rows: &[AcceptedResult],
    cache: &PayloadCache,
) -> Vec<AcceptedResult> {
    let mut seen = Vec::<String>::new();
    rows.iter()
        .rev()
        .filter(|row| !row.payload_removed && cache.get(conversation, row).is_none())
        .filter(|row| {
            let Some(payload) = row.payload_id.as_ref().map(ToString::to_string) else {
                return false;
            };
            let new = !seen.contains(&payload);
            seen.push(payload);
            new
        })
        .cloned()
        .collect()
}

/// Whether `next` holds work the current reader does not have yet.
pub fn adds_work(current: &[AcceptedResult], next: &[AcceptedResult]) -> bool {
    next.iter()
        .any(|row| !current.iter().any(|old| old.payload_id == row.payload_id))
}

/// Requests of at most `PROVIDER_PAYLOAD_BATCH` payload IDs each.
pub fn batches(rows: &[AcceptedResult]) -> Vec<Vec<AcceptedResult>> {
    rows.chunks(PROVIDER_PAYLOAD_BATCH)
        .map(<[AcceptedResult]>::to_vec)
        .collect()
}

/// What one batch read gave: texts that belong to their replies, and the
/// replies to read one by one (left out, or not matching their reply).
#[derive(Debug, Default)]
pub struct BatchRead {
    pub read: Vec<(AcceptedResult, ProviderPayload)>,
    pub alone: Vec<AcceptedResult>,
}

/// Checks a batch answer against the replies it was asked for. An answer for
/// another conversation, or one naming a payload that was not asked for or
/// twice, proves nothing: every reply is then read alone.
pub fn sort_batch(
    conversation: &str,
    asked: &[AcceptedResult],
    answer: &ProviderPayloads,
) -> BatchRead {
    let asked_for = |payload: &ProviderPayload| {
        asked
            .iter()
            .any(|row| row.payload_id.as_ref() == Some(&payload.payload_id))
    };
    let repeated = answer.payloads.iter().enumerate().any(|(at, payload)| {
        answer.payloads[..at]
            .iter()
            .any(|earlier| earlier.payload_id == payload.payload_id)
    });
    if answer.conversation_id.to_string() != conversation
        || repeated
        || !answer.payloads.iter().all(asked_for)
    {
        return BatchRead {
            read: Vec::new(),
            alone: asked.to_vec(),
        };
    }
    let mut sorted = BatchRead::default();
    for row in asked {
        let payload = answer
            .payloads
            .iter()
            .find(|payload| row.payload_id.as_ref() == Some(&payload.payload_id))
            .filter(|payload| bound_payload(row, conversation, payload));
        match payload {
            Some(payload) => sorted.read.push((row.clone(), payload.clone())),
            None => sorted.alone.push(row.clone()),
        }
    }
    sorted
}

/// What a reply shows, from what this page knows about its text.
pub fn answer(
    conversation: &str,
    row: &AcceptedResult,
    cache: &PayloadCache,
    failed: bool,
) -> Answer {
    match cache.get(conversation, row) {
        Some(payload) => Answer::Read(payload.text.clone()),
        None if failed => Answer::Failed,
        None => Answer::Loading,
    }
}
