//! Client outbox: every Send becomes an item with its own idempotency key
//! (`client_message_id`), so the composer never waits for the network and a
//! retry never creates a second message. Items of one chat go out strictly
//! in order (the head blocks the rest until it is definitively sent or
//! refused); different chats send in parallel. Unsent items are persisted
//! by the page and restored after a reload, still under their original keys.
use orkestr_v2_contracts::{
    ExecutionWindowAdmission, ExecutionWindowQueued, ExecutionWindowRequest, QueuedWindowState,
    Receipt, ReplyTo,
};
use serde::{Deserialize, Serialize};

/// Items kept per owner (sent ones included until they reach the timeline).
pub const LIMIT: usize = 200;
/// Sent items stay visible this long when the timeline has not shown them yet.
pub const SENT_RETAIN_MS: f64 = 5.0 * 60_000.0;
/// Restored unsent items older than this are dropped.
pub const RESTORE_MAX_AGE_MS: f64 = 7.0 * 24.0 * 3_600_000.0;
/// Fresh work-request tuples after definitive window conflicts before giving up.
pub const WINDOW_REFUSALS_MAX: u32 = 3;
const TEXT_MAX: usize = 32768;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Waiting for (or inside) an attempt.
    Sending,
    /// Durably admitted, and for a V2 chat its work started or queued.
    Sent,
    /// The last attempt failed. `retrying` says whether it retries by itself.
    Failed,
}

/// Where an item goes: a native V2 conversation or a linked V1 thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Target {
    Native(String),
    V1(String),
}
impl Target {
    /// The composer draft key of this target (`v1:<thread>` for V1).
    pub fn draft_key(&self) -> String {
        match self {
            Self::Native(id) => id.clone(),
            Self::V1(thread) => crate::v1_input::draft_key(thread),
        }
    }
    /// The idempotency key for a new send: `web:<uuid>` for a native
    /// conversation (so the WhatsApp adapter can mirror web input), the bare
    /// UUID for V1, whose input contract requires exactly a UUID.
    pub fn message_key(&self, uuid: &str) -> String {
        match self {
            Self::Native(_) => format!("{}{uuid}", orkestr_v2_contracts::WEB_MESSAGE_KEY_PREFIX),
            Self::V1(_) => uuid.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    /// Idempotency key: the `client_message_id` of every attempt.
    pub key: String,
    pub target: Target,
    /// The exact text sent (a reply carries its `[Replying to …]` line).
    pub text: String,
    #[serde(default)]
    pub reply_to: Option<ReplyTo>,
    /// V1 upload ids frozen with the input.
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    pub created_at_ms: f64,
    pub phase: Phase,
    /// Failed attempts since the last success or manual retry.
    #[serde(default)]
    pub attempts: u32,
    /// Earliest time of the next automatic attempt.
    #[serde(default)]
    pub next_at_ms: f64,
    /// A failed item retries by itself; false needs a manual Retry.
    #[serde(default)]
    pub retrying: bool,
    #[serde(default)]
    pub notice: String,
    /// V2 intake receipt once the message is durably saved.
    #[serde(default)]
    pub receipt: Option<Receipt>,
    /// The frozen work request; retried verbatim until definitively answered.
    #[serde(default)]
    pub window: Option<ExecutionWindowRequest>,
    #[serde(default)]
    pub window_refusals: u32,
    /// Server message id (V2 message UUID or V1 message id) once known.
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub sent_at_ms: Option<f64>,
    /// False while the Send gesture still waits for its key: the item holds
    /// its place in order but is neither attempted nor persisted.
    #[serde(default = "ready")]
    pub ready: bool,
    /// Page-local identity for rendering; never changes, never persisted.
    #[serde(skip)]
    pub local: String,
}
fn ready() -> bool {
    true
}

impl Item {
    /// A new item in its final place, still without its key (see [`Outbox::activate`]).
    pub fn new(
        local_key: String,
        target: Target,
        text: String,
        reply_to: Option<ReplyTo>,
        attachment_ids: Vec<String>,
    ) -> Result<Self, &'static str> {
        let max = match target {
            Target::Native(_) => TEXT_MAX,
            Target::V1(_) => orkestr_v2_contracts::V1_INPUT_TEXT_MAX,
        };
        if text.trim().is_empty() || text.len() > max || text.contains('\0') {
            return Err(match target {
                Target::Native(_) => "Message must contain 1–32768 UTF-8 bytes.",
                Target::V1(_) => "A V1 message must contain at most 16384 UTF-8 bytes.",
            });
        }
        Ok(Self {
            local: local_key.clone(),
            key: local_key,
            target,
            text,
            reply_to,
            attachment_ids,
            created_at_ms: 0.0,
            phase: Phase::Sending,
            attempts: 0,
            next_at_ms: 0.0,
            retrying: true,
            notice: String::new(),
            receipt: None,
            window: None,
            window_refusals: 0,
            message_id: None,
            sent_at_ms: None,
            ready: false,
        })
    }
    /// Text shown in the bubble (the quote is shown separately).
    pub fn display_text(&self) -> String {
        if self.reply_to.is_some() {
            crate::chat_timeline::without_reply_line(&self.text)
        } else {
            self.text.clone()
        }
    }
    /// Stable identity for rendering (a reserved item keeps it when keyed).
    pub fn view_key(&self) -> &str {
        if self.local.is_empty() {
            &self.key
        } else {
            &self.local
        }
    }
    pub fn state_label(&self) -> &'static str {
        match self.phase {
            Phase::Sending => "Sending",
            Phase::Sent => "Sent",
            Phase::Failed => "Failed",
        }
    }
    fn due(&self, now_ms: f64) -> bool {
        if !self.ready {
            return false;
        }
        match self.phase {
            Phase::Sending => self.next_at_ms <= now_ms,
            Phase::Failed => self.retrying && self.next_at_ms <= now_ms,
            Phase::Sent => false,
        }
    }
}

/// Exponential backoff with a cap: 1 s, 2 s, 4 s … 60 s.
pub fn backoff_ms(attempts: u32) -> f64 {
    let exp = attempts.saturating_sub(1).min(6);
    (1000.0 * f64::from(1u32 << exp)).min(60_000.0)
}

/// What one attempt learned.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// The message is durably saved (V2 intake).
    Saved(Receipt),
    /// A work request was frozen for the saved message.
    Prepared(ExecutionWindowRequest),
    /// Done: work started or queued (V2), or V1 admitted it.
    Sent {
        message_id: Option<String>,
        notice: String,
    },
    /// The previous work is still settling: wait without counting a failure.
    Wait(String),
    /// No definite answer: retry the same request after a backoff.
    Transient(String),
    /// The frozen work tuple went stale (HTTP 409): prepare a fresh one.
    WindowConflict,
    /// A definite refusal: only a manual Retry continues.
    Refused(String),
    /// A definite refusal of the key itself; manual Retry uses a new key.
    KeyConflict(String),
}

#[derive(Default)]
pub struct Outbox {
    items: Vec<Item>,
    /// Bumped on every change that may make an item due.
    revision: u64,
}

impl Outbox {
    pub fn items(&self) -> &[Item] {
        &self.items
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn is_full(&self) -> bool {
        self.items.len() >= LIMIT
    }
    pub fn get(&self, key: &str) -> Option<&Item> {
        self.items.iter().find(|item| item.key == key)
    }
    /// Items of one target in send order.
    pub fn for_target<'a>(&'a self, target: &'a Target) -> impl Iterator<Item = &'a Item> + 'a {
        self.items.iter().filter(move |item| &item.target == target)
    }
    /// The delivery state of a server message this outbox sent, if any.
    pub fn by_message(&self, message_id: &str) -> Option<&Item> {
        self.items
            .iter()
            .find(|item| item.message_id.as_deref() == Some(message_id))
    }
    pub fn enqueue(&mut self, item: Item) -> bool {
        if self.get(&item.key).is_some() {
            return false;
        }
        if self.is_full() {
            // Make room by dropping the oldest already sent item.
            let Some(index) = self.items.iter().position(|i| i.phase == Phase::Sent) else {
                return false;
            };
            self.items.remove(index);
        }
        self.items.push(item);
        self.revision += 1;
        true
    }
    /// Give a reserved item its idempotency key; from now on it is sent and persisted.
    pub fn activate(&mut self, local_key: &str, key: String, now_ms: f64) -> bool {
        if key.is_empty()
            || key.len() > 128
            || key.chars().any(char::is_control)
            || self.get(&key).is_some()
        {
            return false;
        }
        let Some(item) = self
            .items
            .iter_mut()
            .find(|i| i.key == local_key && !i.ready)
        else {
            return false;
        };
        item.key = key;
        item.ready = true;
        item.created_at_ms = now_ms;
        item.next_at_ms = now_ms;
        self.revision += 1;
        true
    }
    /// Drop a reserved item that never got its key; returns it.
    pub fn abandon(&mut self, local_key: &str) -> Option<Item> {
        let index = self
            .items
            .iter()
            .position(|i| i.key == local_key && !i.ready)?;
        self.revision += 1;
        Some(self.items.remove(index))
    }
    /// The next item to attempt for `target`: the first unsent item, unless it
    /// waits for a manual Retry (then later items may go). Order holds because
    /// an item that retries by itself blocks everything behind it.
    pub fn head<'a>(&'a self, target: &'a Target, now_ms: f64) -> Option<&'a Item> {
        let item = self.for_target(target).find(|item| {
            item.phase != Phase::Sent && (item.phase != Phase::Failed || item.retrying)
        })?;
        item.due(now_ms).then_some(item)
    }
    /// Targets with an item due now.
    pub fn due_targets(&self, now_ms: f64) -> Vec<Target> {
        let mut targets: Vec<Target> = Vec::new();
        for item in &self.items {
            if !targets.contains(&item.target) && self.head(&item.target, now_ms).is_some() {
                targets.push(item.target.clone());
            }
        }
        targets
    }
    /// Milliseconds until the next automatic attempt (None when nothing waits).
    pub fn next_due_in(&self, now_ms: f64) -> Option<f64> {
        self.items
            .iter()
            .filter(|i| {
                i.ready && (i.phase == Phase::Sending || (i.phase == Phase::Failed && i.retrying))
            })
            .map(|i| (i.next_at_ms - now_ms).max(0.0))
            .reduce(f64::min)
    }
    /// Apply an attempt's outcome to item `key`.
    pub fn apply(&mut self, key: &str, outcome: Outcome, now_ms: f64) {
        let Some(item) = self.items.iter_mut().find(|i| i.key == key) else {
            return;
        };
        self.revision += 1;
        match outcome {
            Outcome::Saved(receipt) => {
                item.message_id = Some(receipt.message_id.to_string());
                item.receipt = Some(receipt);
                item.phase = Phase::Sending;
                item.attempts = 0;
                item.next_at_ms = now_ms;
                item.notice = "Saved. Starting work…".into();
            }
            Outcome::Prepared(request) => {
                item.window = Some(request);
                item.next_at_ms = now_ms;
            }
            Outcome::Sent { message_id, notice } => {
                if message_id.is_some() {
                    item.message_id = message_id;
                }
                item.phase = Phase::Sent;
                item.notice = notice;
                item.sent_at_ms = Some(now_ms);
                item.retrying = false;
            }
            Outcome::Wait(notice) => {
                item.phase = Phase::Sending;
                item.notice = notice;
                item.next_at_ms = now_ms + 3000.0;
            }
            Outcome::Transient(notice) => {
                item.attempts = item.attempts.saturating_add(1);
                item.phase = Phase::Failed;
                item.retrying = true;
                item.notice = notice;
                item.next_at_ms = now_ms + backoff_ms(item.attempts);
            }
            Outcome::WindowConflict => {
                item.window = None;
                item.window_refusals += 1;
                if item.window_refusals >= WINDOW_REFUSALS_MAX {
                    item.phase = Phase::Failed;
                    item.retrying = false;
                    item.notice = "Saved, but work could not start. Finish or stop the current work, then Retry.".into();
                } else {
                    item.phase = Phase::Sending;
                    item.next_at_ms = now_ms + 1000.0;
                }
            }
            Outcome::Refused(notice) => {
                item.phase = Phase::Failed;
                item.retrying = false;
                item.notice = notice;
            }
            Outcome::KeyConflict(notice) => {
                item.phase = Phase::Failed;
                item.retrying = false;
                item.notice = notice;
                // A new key is chosen by a manual Retry (see `retry`).
                item.receipt = None;
                item.window = None;
            }
        }
    }
    /// Manual Retry (or reconnect): attempt now. A refused item starts over
    /// with a fresh work request; `new_key` replaces a conflicting key.
    pub fn retry(&mut self, key: &str, new_key: Option<String>, now_ms: f64) -> bool {
        let Some(item) = self.items.iter_mut().find(|i| i.key == key) else {
            return false;
        };
        if item.phase == Phase::Sent {
            return false;
        }
        if item.phase == Phase::Failed && !item.retrying {
            item.window = None;
            item.window_refusals = 0;
            if item.receipt.is_none() {
                if let Some(new_key) = new_key {
                    item.key = new_key;
                }
            }
        }
        item.phase = Phase::Sending;
        item.retrying = true;
        item.attempts = 0;
        item.next_at_ms = now_ms;
        item.notice.clear();
        self.revision += 1;
        true
    }
    /// Connection back or tab visible again: retry waiting items at once.
    pub fn wake(&mut self, now_ms: f64) {
        let mut changed = false;
        for item in &mut self.items {
            if item.phase != Phase::Sent && item.retrying && item.next_at_ms > now_ms {
                item.next_at_ms = now_ms;
                changed = true;
            }
        }
        if changed {
            self.revision += 1;
        }
    }
    pub fn discard(&mut self, key: &str) -> bool {
        let before = self.items.len();
        self.items
            .retain(|i| i.key != key || i.phase == Phase::Sent);
        let changed = self.items.len() != before;
        if changed {
            self.revision += 1;
        }
        changed
    }
    /// Whether `prune` would forget anything by age.
    pub fn has_expired_sent(&self, now_ms: f64) -> bool {
        self.items.iter().any(|i| {
            i.phase == Phase::Sent && i.sent_at_ms.is_some_and(|at| now_ms - at > SENT_RETAIN_MS)
        })
    }
    /// Forget sent items the timeline shows (`seen`) or that are old enough.
    pub fn prune(&mut self, now_ms: f64, seen: impl Fn(&Item) -> bool) {
        let before = self.items.len();
        self.items.retain(|i| {
            i.phase != Phase::Sent
                || !(seen(i) || i.sent_at_ms.is_some_and(|at| now_ms - at > SENT_RETAIN_MS))
        });
        if self.items.len() != before {
            self.revision += 1;
        }
    }
    pub fn clear_owner(&mut self) {
        self.items.clear();
        self.revision += 1;
    }
    /// Unsent items for persistence, keyed by idempotency key.
    pub fn persistable(&self) -> Vec<(String, String)> {
        self.items
            .iter()
            .filter(|i| i.phase != Phase::Sent && i.ready)
            .filter_map(|i| Some((i.key.clone(), serde_json::to_string(i).ok()?)))
            .collect()
    }
    /// Restore persisted items (any order) without replacing items in memory.
    /// Returns how many were restored.
    pub fn restore(&mut self, raw: &[String], now_ms: f64) -> usize {
        let mut items: Vec<Item> = raw
            .iter()
            .filter_map(|text| serde_json::from_str::<Item>(text).ok())
            .filter(|i| {
                i.phase != Phase::Sent
                    && i.ready
                    && now_ms - i.created_at_ms < RESTORE_MAX_AGE_MS
                    && !i.text.trim().is_empty()
                    && i.text.len() <= TEXT_MAX
                    && !i.key.is_empty()
                    && i.key.len() <= 128
            })
            .collect();
        items.sort_by(|a, b| a.created_at_ms.total_cmp(&b.created_at_ms));
        let mut count = 0;
        for mut item in items {
            // A restored item that was mid-attempt continues by itself.
            if item.phase == Phase::Sending || item.retrying {
                item.next_at_ms = now_ms;
            }
            if self.get(&item.key).is_none() && self.items.len() < LIMIT {
                self.items.push(item);
                count += 1;
            }
        }
        if count > 0 {
            self.items
                .sort_by(|a, b| a.created_at_ms.total_cmp(&b.created_at_ms));
            self.revision += 1;
        }
        count
    }
}

/// Whether a window admission receipt answers exactly `request`.
pub fn admission_matches(
    request: &ExecutionWindowRequest,
    receipt: &ExecutionWindowAdmission,
    conversation: &str,
) -> bool {
    let mut intent = crate::beta_window::WindowIntent::default();
    intent.prepare(request.clone()).is_some()
        && receipt.status.conversation_id.to_string() == conversation
        && crate::beta_window::valid_status(&receipt.status, conversation)
        && intent.receipt_matches(intent.generation(), receipt)
}

/// Whether a durable queue receipt (HTTP 202) names exactly `request`.
pub fn queue_matches(
    request: &ExecutionWindowRequest,
    queued: &ExecutionWindowQueued,
    conversation: &str,
) -> bool {
    queued.conversation_id.to_string() == conversation
        && request.request_key == queued.request_key
        && request.input_message_id == queued.input_message_id
        && request.input_event_id == queued.input_event_id
        && request.input_request_key == queued.input_request_key
        && queued.state != QueuedWindowState::Withdrawn
}

/// Owner-facing wording for an HTTP status that did not admit an input.
pub fn intake_outcome(status: u16, message: &str) -> Outcome {
    match status {
        409 => Outcome::KeyConflict(format!("{message} Retry sends it as a new message.")),
        400 | 403 | 404 | 413 | 422 => Outcome::Refused(message.to_string()),
        _ => Outcome::Transient(if message.is_empty() {
            "Not sent yet; retrying.".into()
        } else {
            format!("{message} Retrying automatically.")
        }),
    }
}
