//! View of the V1 thread registry for the sidebar. V1 stays the authority for
//! its threads; this module reads (through the private loopback V1 client),
//! bounds and caches what the sidebar shows, and forwards owner input into a
//! listed thread as V1 web UI input. Nothing here admits V2 work.
use crate::desktop_broker::{Broker, BrokerError};
use orkestr_v2_contracts::{
    valid_v1_instance_ref, valid_v1_thread_id, valid_v1_thread_ref, MessageReceipt,
    MessageReceiptKind, SidebarAuthor, SidebarPreview, V1HistoryMessage, V1HistoryPage,
    V1ThreadInput, V1ThreadInputReceipt, SIDEBAR_NAME_MAX, SIDEBAR_PREVIEW_MAX, V1_HISTORY_MAX,
    V1_HISTORY_TEXT_MAX,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

/// V1 registry responses are large (every thread's runtime state).
const REGISTRY_CAP: usize = 8 * 1024 * 1024;
const MESSAGES_CAP: usize = 2 * 1024 * 1024;
const FRESH: Duration = Duration::from_secs(15);
/// A stale registry is still better than none while V1 restarts.
const STALE: Duration = Duration::from_secs(120);
/// Preview reads per background fill; the rest fill in on later polls.
pub(crate) const PREVIEW_READS: usize = 8;
/// How long a sidebar request waits for previews it has never shown (first
/// paint only); changed threads keep their old preview until the fill lands.
const PREVIEW_WAIT: Duration = Duration::from_millis(150);
/// A failed preview read is retried after this long.
const PREVIEW_RETRY: Duration = STALE;

/// One V1 thread, reduced to what the sidebar shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V1Thread {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
    pub kind: Option<String>,
    pub last_activity_ms: Option<i64>,
    pub last_cursor: i64,
    pub last_role: Option<String>,
    pub last_message_id: Option<String>,
    pub working: bool,
    /// Bound to an enabled WhatsApp chat (an owner group thread).
    pub whatsapp: bool,
    /// The V1 binding delegates this thread's runtime to a remote (V2)
    /// backend. Its owner input belongs to the V2 conversation, not V1.
    pub delegated: bool,
    /// The remote (V2 conversation) id a delegated thread runs in.
    pub delegated_to: Option<String>,
    pub retired: bool,
    /// V1 public reference (`thr_…`) of old deep links.
    pub public_ref: Option<String>,
    /// The instance reference of its canonical path (`/instance/ins_…/…`).
    pub instance_ref: Option<String>,
    /// Bound WhatsApp chat id and the label V1 draws its chat icon from.
    pub chat_id: Option<String>,
    pub icon_title: String,
    /// The thread's Codex thread (session) id, for usage attribution.
    pub codex_thread_id: Option<String>,
    /// The thread's working directory, for usage attribution (never shown).
    pub workspace: Option<String>,
}

impl V1Thread {
    /// The WhatsApp group name of an owner group thread: the chat's display
    /// name, else the thread name (never the raw chat id).
    pub(crate) fn whatsapp_group(&self) -> Option<String> {
        self.whatsapp.then(|| {
            if self.chat_id.as_deref() == Some(self.icon_title.as_str()) {
                self.name.clone()
            } else {
                self.icon_title.clone()
            }
        })
    }

    /// The V2 conversation this thread's runtime is delegated to, when the
    /// V1 binding names it directly (`remoteThreadId` = conversation id).
    pub(crate) fn delegated_conversation(&self) -> Option<uuid::Uuid> {
        self.delegated_to
            .as_deref()
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
            .filter(|id| !id.is_nil())
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}
fn number(value: &Value, key: &str) -> Option<i64> {
    match value.get(key)? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}
fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}
/// Free display text: control characters become spaces, then bounded.
pub(crate) fn display(value: &str, max: usize) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

pub(crate) fn parse_thread(value: &Value) -> Option<V1Thread> {
    let id = text(value, "id").filter(|id| valid_v1_thread_id(id))?;
    let name = text(value, "name")
        .or_else(|| text(value, "title"))
        .map(|n| display(&n, SIDEBAR_NAME_MAX))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| id.clone());
    let binding = value.get("binding").filter(|b| b.is_object());
    let whatsapp = binding.is_some_and(|b| {
        b.get("connector").and_then(Value::as_str) == Some("whatsapp")
            && b.get("enabled").and_then(Value::as_bool) != Some(false)
            && !flag(b, "retired")
    });
    // Mirrors V1 `remoteWhatsAppRuntimeBinding()`: a remote thread id and a
    // runtime switch that is not off. Fails closed: any remote id counts
    // unless V1 says the runtime is explicitly disabled.
    let delegated_to = binding.and_then(|b| {
        let remote = [
            "remoteThreadId",
            "remoteRuntimeThreadId",
            "delegatedThreadId",
        ]
        .iter()
        .find_map(|k| text(b, k))?;
        (b.get("remoteRuntimeEnabled").and_then(Value::as_bool) != Some(false)
            && b.get("remoteRouterEnabled").and_then(Value::as_bool) != Some(false))
        .then_some(remote)
    });
    let delegated = delegated_to.is_some();
    let last_activity_ms = ["lastActivityAt", "lastMessageAt", "updatedAt"]
        .iter()
        .find_map(|k| text(value, k).and_then(|t| crate::live_map::timestamp_ms(&t)))
        .filter(|t| *t > 0);
    // V1 web UI: a chat-bound thread is labelled by its chat display name
    // (or chat id), any other thread by its own name.
    let chat_id = binding
        .and_then(|b| text(b, "chatId"))
        .filter(|c| c.len() <= 200 && !c.chars().any(char::is_control));
    let icon_title = match &chat_id {
        Some(chat) => binding
            .and_then(|b| text(b, "displayName"))
            .map(|n| display(&n, SIDEBAR_NAME_MAX))
            .unwrap_or_else(|| chat.clone()),
        None => name.clone(),
    };
    Some(V1Thread {
        chat_id,
        icon_title,
        codex_thread_id: text(value, "codexThreadId").filter(|t| t.len() <= 120),
        workspace: text(value, "workspace")
            .or_else(|| text(value, "cwd"))
            .filter(|w| w.starts_with('/') && w.len() <= 4096),
        parent: text(value, "parentThreadId").filter(|p| valid_v1_thread_id(p) && *p != id),
        kind: text(value, "threadKind"),
        last_activity_ms,
        last_cursor: number(value, "lastMessageCursor").unwrap_or(0).max(0),
        last_role: text(value, "lastMessageRole"),
        last_message_id: text(value, "lastMessageId"),
        working: flag(value, "working")
            || flag(value, "foregroundWorking")
            || number(value, "runningCount").is_some_and(|n| n > 0),
        whatsapp,
        delegated,
        delegated_to,
        retired: flag(value, "retired"),
        public_ref: text(value, "publicRef").filter(|r| valid_v1_thread_ref(r)),
        instance_ref: text(value, "canonicalPath").and_then(|path| {
            path.strip_prefix("/instance/")
                .and_then(|rest| rest.split('/').next())
                .filter(|r| valid_v1_instance_ref(r))
                .map(str::to_owned)
        }),
        id,
        name,
    })
}

pub(crate) fn parse_registry(value: &Value) -> Option<Vec<V1Thread>> {
    let threads = value.get("threads")?.as_array()?;
    Some(threads.iter().filter_map(parse_thread).collect())
}

/// Owner group threads and their sub-threads, never task agents or retired
/// threads. `imported` threads already live in V2 and are listed there.
pub(crate) fn listed<'a>(
    threads: &'a [V1Thread],
    imported: &dyn Fn(&str) -> bool,
) -> Vec<&'a V1Thread> {
    let active = |t: &&V1Thread| !t.retired && t.kind.as_deref() != Some("task-agent");
    let roots: std::collections::HashSet<&str> = threads
        .iter()
        .filter(active)
        .filter(|t| t.whatsapp)
        .map(|t| t.id.as_str())
        .collect();
    // A sub-thread is listed when its parent chain reaches an owner group thread.
    let by_id: HashMap<&str, &V1Thread> = threads.iter().map(|t| (t.id.as_str(), t)).collect();
    let reaches_root = |thread: &V1Thread| {
        let mut current = thread;
        for _ in 0..8 {
            if roots.contains(current.id.as_str()) {
                return true;
            }
            match current.parent.as_deref().and_then(|p| by_id.get(p)) {
                Some(parent) => current = parent,
                None => return false,
            }
        }
        false
    };
    threads
        .iter()
        .filter(active)
        .filter(|t| reaches_root(t))
        .filter(|t| !imported(&t.id))
        .collect()
}

/// The parent a `worker-<parent>-<suffix>` thread id encodes, when V1 gave none.
pub(crate) fn encoded_parent(id: &str, known: &dyn Fn(&str) -> bool) -> Option<String> {
    let rest = id.strip_prefix("worker-")?;
    let (parent, suffix) = rest.rsplit_once('-')?;
    (!suffix.is_empty() && known(parent)).then(|| parent.to_owned())
}

fn author(message: &Value) -> SidebarAuthor {
    match message.get("role").and_then(Value::as_str) {
        Some("user") => {
            let role =
                text(message, "senderEffectiveRole").or_else(|| text(message, "senderTrustLevel"));
            match role.as_deref() {
                None | Some("owner") => SidebarAuthor::Owner,
                Some(_) => SidebarAuthor::Participant,
            }
        }
        _ => SidebarAuthor::Assistant,
    }
}

/// One line of preview text: connector headers such as `[WhatsApp: …]` and
/// blank lines are skipped; whitespace is collapsed; bounded.
pub(crate) fn preview_text(value: &str) -> String {
    let line = value
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !(l.starts_with('[') && l.ends_with(']') && l.contains(':')))
        .unwrap_or("");
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = display(&collapsed, SIDEBAR_PREVIEW_MAX);
    if collapsed.chars().count() > SIDEBAR_PREVIEW_MAX {
        out = out
            .chars()
            .take(SIDEBAR_PREVIEW_MAX - 1)
            .collect::<String>()
            + "…";
    }
    out
}

pub(crate) fn preview(author: SidebarAuthor, value: &str) -> Option<SidebarPreview> {
    let text = preview_text(value);
    (!text.is_empty()).then_some(SidebarPreview { author, text })
}

fn bounded(value: &str) -> String {
    let mut end = value.len().min(V1_HISTORY_TEXT_MAX);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

/// V1 thread runtime states that mean a turn is running.
const WORKING_STATES: [&str; 4] = ["working", "running", "busy", "thinking"];
/// V1 owner-input states before its turn has answered.
const PENDING_INPUT: [&str; 4] = ["queued", "pending_delivery", "awaiting_ack", "running"];

/// V1 `GET /api/threads/:id/messages` → bounded page.
fn at(m: &Value, key: &str) -> Option<i64> {
    text(m, key)
        .and_then(|t| crate::live_map::timestamp_ms(&t))
        .filter(|t| *t > 0)
}

/// Receipts V1 recorded on one message, in the order they happened. Only
/// recorded states count; a missing time stays missing.
pub(crate) fn receipts(m: &Value) -> Vec<MessageReceipt> {
    use MessageReceiptKind as K;
    let mut out = Vec::new();
    if let Some(ack) = m.get("remoteMirrorAck").filter(|a| a.is_object()) {
        let kind = match ack.get("outcome").and_then(Value::as_str) {
            Some("delivered") => Some(K::HandedToV1),
            Some("suppressed") => Some(K::SuppressedByV1),
            Some("failed") => Some(K::Failed),
            _ => None,
        };
        if let Some(kind) = kind {
            out.push(MessageReceipt {
                kind,
                at_ms: at(ack, "acknowledgedAt"),
            });
        }
    }
    let whatsapp = text(m, "connector").as_deref() == Some("whatsapp")
        || m.get("whatsappMessageIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| !ids.is_empty());
    // An owner's inbound WhatsApp message has nothing to deliver.
    let outbound = m.get("role").and_then(Value::as_str) == Some("assistant");
    match text(m, "deliveryState").as_deref() {
        Some("delivered") if outbound => out.push(MessageReceipt {
            kind: if whatsapp {
                K::SentToWhatsapp
            } else {
                K::DeliveredInApp
            },
            at_ms: at(m, "deliveredAt"),
        }),
        Some("failed" | "delivery_failed" | "dead_letter") if outbound => {
            out.push(MessageReceipt {
                kind: K::Failed,
                at_ms: at(m, "deliveryLastAttemptAt"),
            })
        }
        Some("pending_delivery" | "awaiting_ack" | "queued_delivery" | "delivering")
            if outbound =>
        {
            out.push(MessageReceipt {
                kind: K::Pending,
                at_ms: None,
            })
        }
        _ => {}
    }
    out.truncate(8);
    out
}

/// Receipts of V2 replies exported to V1, keyed by the V2 acceptance event
/// (`remoteMessageId`), from one V1 messages page.
pub(crate) fn export_receipts(value: &Value) -> HashMap<String, Vec<MessageReceipt>> {
    value
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| text(m, "remoteBackend").is_some())
        .filter_map(|m| Some((text(m, "remoteMessageId")?, receipts(m))))
        .filter(|(_, r)| !r.is_empty())
        .collect()
}

pub(crate) fn history(
    thread: &V1Thread,
    coordinator: bool,
    value: &Value,
) -> Option<V1HistoryPage> {
    let raw = value.get("messages")?.as_array()?;
    let mut messages: Vec<V1HistoryMessage> = raw
        .iter()
        .filter_map(|m| {
            let cursor = number(m, "cursor")?;
            let id =
                text(m, "id").filter(|id| id.len() <= 256 && !id.chars().any(char::is_control))?;
            let body = m.get("text").and_then(Value::as_str).unwrap_or("");
            if body.trim().is_empty() || cursor < 0 {
                return None;
            }
            Some(V1HistoryMessage {
                message_id: id,
                author: author(m),
                text: bounded(body),
                created_at_ms: text(m, "createdAt").and_then(|t| crate::live_map::timestamp_ms(&t)),
                phase: text(m, "phase")
                    .filter(|p| p.len() <= 64 && !p.chars().any(char::is_control)),
                cursor,
                coordinator: m.get("role").and_then(Value::as_str) == Some("assistant")
                    && text(m, "source").as_deref() == Some("api-session"),
                receipts: receipts(m),
            })
        })
        .collect();
    messages.sort_by_key(|m| m.cursor);
    messages.dedup_by_key(|m| m.cursor);
    if messages.len() > V1_HISTORY_MAX {
        messages.drain(..messages.len() - V1_HISTORY_MAX);
    }
    let latest = messages.last().map_or(0, |m| m.cursor);
    let before_cursor = value
        .get("hasMoreBefore")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        .then(|| messages.first().map(|m| m.cursor))
        .flatten();
    Some(V1HistoryPage {
        thread_id: thread.id.clone(),
        name: thread.name.clone(),
        coordinator,
        messages,
        before_cursor,
        latest_cursor: number(value, "currentCursor").unwrap_or(latest).max(latest),
        writable: !thread.delegated,
        working: thread.working
            || text(value, "state").is_some_and(|s| WORKING_STATES.contains(&s.as_str()))
            || raw.iter().any(|m| {
                m.get("role").and_then(Value::as_str) == Some("user")
                    && text(m, "state").is_some_and(|s| PENDING_INPUT.contains(&s.as_str()))
            }),
    })
}

/// Latest (highest cursor) non-empty message of a V1 page as a preview.
pub(crate) fn latest_preview(value: &Value) -> Option<SidebarPreview> {
    value
        .get("messages")?
        .as_array()?
        .iter()
        .filter_map(|m| Some((number(m, "cursor")?, m)))
        .filter_map(|(cursor, m)| Some((cursor, preview(author(m), m.get("text")?.as_str()?)?)))
        .max_by_key(|(cursor, _)| *cursor)
        .map(|(_, preview)| preview)
}

#[derive(Default)]
struct CacheState {
    registry: Option<(Instant, Arc<Vec<V1Thread>>)>,
    /// A background registry read is running.
    refreshing: bool,
    /// A background preview fill is running; resolves to `true` when done.
    filling: Option<tokio::sync::watch::Receiver<bool>>,
    /// thread id -> the preview read for the thread's last V1 message.
    previews: HashMap<String, CachedPreview>,
}

/// A resolved preview: read for `last` (V1's last message id). `preview` is
/// `None` for a thread without text. A failed read keeps the previous preview
/// and counts as resolved until `PREVIEW_RETRY` has passed, so a V1 error or
/// a retired thread never makes every sidebar request wait again.
#[derive(Clone)]
struct CachedPreview {
    last: String,
    preview: Option<SidebarPreview>,
    failed_at: Option<Instant>,
}

impl CachedPreview {
    fn resolves(&self, last: &str) -> bool {
        self.last == last && self.failed_at.is_none_or(|at| at.elapsed() < PREVIEW_RETRY)
    }
}

/// Process-wide cache. The registry is read from V1 at most once per
/// `FRESH` interval; after that the cached copy is served at once while one
/// background read replaces it, so no sidebar request waits for V1's
/// multi-megabyte registry unless no copy younger than `STALE` exists.
#[derive(Default, Clone)]
pub(crate) struct V1Cache {
    state: Arc<std::sync::Mutex<CacheState>>,
    /// Single flight: concurrent cold callers share one registry read.
    fetch: Arc<tokio::sync::Mutex<()>>,
}

async fn read_registry(broker: &Broker) -> Option<Arc<Vec<V1Thread>>> {
    match broker
        .read("/api/threads/summary?includeRetired=1", REGISTRY_CAP)
        .await
    {
        Ok((200, value)) => parse_registry(&value).map(Arc::new),
        _ => None,
    }
}

impl V1Cache {
    fn lock(&self) -> std::sync::MutexGuard<'_, CacheState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A copy younger than `limit`, if any.
    fn cached(&self, limit: Duration) -> Option<Arc<Vec<V1Thread>>> {
        self.lock()
            .registry
            .as_ref()
            .filter(|(at, _)| at.elapsed() < limit)
            .map(|(_, threads)| threads.clone())
    }

    /// One registry read; keeps the previous copy when V1 does not answer.
    async fn refresh(&self, broker: &Broker) -> Option<Arc<Vec<V1Thread>>> {
        let fetched = read_registry(broker).await;
        let mut state = self.lock();
        state.refreshing = false;
        match fetched {
            Some(threads) => {
                state.registry = Some((Instant::now(), threads.clone()));
                Some(threads)
            }
            None => state
                .registry
                .as_ref()
                .filter(|(at, _)| at.elapsed() < STALE)
                .map(|(_, t)| t.clone()),
        }
    }

    pub(crate) async fn registry(&self, broker: &Arc<Broker>) -> Option<Arc<Vec<V1Thread>>> {
        {
            let mut state = self.lock();
            if let Some((at, threads)) = &state.registry {
                let age = at.elapsed();
                if age < FRESH {
                    return Some(threads.clone());
                }
                if age < STALE {
                    let threads = threads.clone();
                    if !state.refreshing {
                        state.refreshing = true;
                        let (cache, broker) = (self.clone(), broker.clone());
                        tokio::spawn(async move {
                            let _single = cache.fetch.lock().await;
                            cache.refresh(&broker).await;
                        });
                    }
                    return Some(threads);
                }
            }
        }
        // No usable copy: wait for one read, shared with concurrent callers.
        let _single = self.fetch.lock().await;
        if let Some(threads) = self.cached(FRESH) {
            return Some(threads);
        }
        self.refresh(broker).await
    }

    /// Cached previews for `threads` (newest first). Missing or outdated
    /// ones are read from V1 by one background fill (at most `PREVIEW_READS`
    /// sequential reads; V1 serves them one at a time anyway). A request waits
    /// for that fill, up to `PREVIEW_WAIT`, only when a thread has never had a
    /// preview read; otherwise it answers at once with what is cached.
    pub(crate) async fn previews(
        &self,
        broker: &Arc<Broker>,
        threads: &[&V1Thread],
    ) -> HashMap<String, SidebarPreview> {
        let (wanted, unseen) = {
            let state = self.lock();
            let wanted: Vec<(String, String)> = threads
                .iter()
                .filter_map(|t| Some((t.id.clone(), t.last_message_id.clone()?)))
                .filter(|(id, last)| state.previews.get(id).is_none_or(|c| !c.resolves(last)))
                .take(PREVIEW_READS)
                .collect();
            let unseen = wanted
                .iter()
                .any(|(id, _)| !state.previews.contains_key(id));
            (wanted, unseen)
        };
        if !wanted.is_empty() {
            let mut done = {
                let mut state = self.lock();
                match &state.filling {
                    Some(done) => done.clone(),
                    None => {
                        let (finished, done) = tokio::sync::watch::channel(false);
                        state.filling = Some(done.clone());
                        let (cache, broker) = (self.clone(), broker.clone());
                        tokio::spawn(async move {
                            for (id, last) in wanted {
                                let path = format!("/api/threads/{id}/messages?limit=3");
                                let read = broker.read(&path, MESSAGES_CAP).await;
                                let mut state = cache.lock();
                                let previous =
                                    state.previews.get(&id).and_then(|c| c.preview.clone());
                                let entry = match read {
                                    Ok((200, value)) => CachedPreview {
                                        last,
                                        preview: latest_preview(&value),
                                        failed_at: None,
                                    },
                                    _ => CachedPreview {
                                        last,
                                        preview: previous,
                                        failed_at: Some(Instant::now()),
                                    },
                                };
                                state.previews.insert(id, entry);
                            }
                            cache.lock().filling = None;
                            let _ = finished.send(true);
                        });
                        done
                    }
                }
            };
            if unseen {
                let _ =
                    tokio::time::timeout(PREVIEW_WAIT, done.wait_for(|finished| *finished)).await;
            }
        }
        let state = self.lock();
        threads
            .iter()
            .filter_map(|t| Some((t.id.clone(), state.previews.get(&t.id)?.preview.clone()?)))
            .collect()
    }

    /// Previews already cached for these threads. Never reads V1.
    pub(crate) fn cached_previews<'a>(
        &self,
        ids: impl Iterator<Item = &'a str>,
    ) -> HashMap<String, SidebarPreview> {
        let state = self.lock();
        ids.filter_map(|id| Some((id.to_owned(), state.previews.get(id)?.preview.clone()?)))
            .collect()
    }

    pub(crate) async fn history(
        &self,
        broker: &Broker,
        thread: &V1Thread,
        coordinator: bool,
        before: Option<i64>,
    ) -> Result<V1HistoryPage, BrokerError> {
        let mut path = format!("/api/threads/{}/messages?limit={V1_HISTORY_MAX}", thread.id);
        if let Some(before) = before {
            path.push_str(&format!("&before={before}"));
        }
        match broker.read(&path, MESSAGES_CAP).await? {
            (200, value) => history(thread, coordinator, &value).ok_or(BrokerError::Unavailable),
            (404, _) => Err(BrokerError::Denied),
            _ => Err(BrokerError::Unavailable),
        }
    }
}

/// Why V1 did not confirm an owner input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InputFailure {
    /// V1 does not know the thread or refuses this principal.
    NotFound,
    /// The key is already used for a different text.
    KeyConflict,
    /// V1 answered with a definite refusal (its code, when it gave one).
    Refused(String),
    /// No answer: the input may or may not be admitted. Retry with the key.
    Unknown,
}

/// The V1 idempotency key for one V2 owner input. V1 dedupes per thread on
/// `clientMessageId`, so a retried request returns the first message.
pub(crate) fn v1_client_message_id(input: &V1ThreadInput) -> String {
    format!("orkestr-v2-{}", input.client_message_id)
}

/// V1 `POST /api/threads/:id/ui-input` body, what the V1 web UI sends with
/// its WhatsApp reply switch off. `ui_only` creates no reply delivery intent,
/// and the scoped group relay only answers inputs it routed itself, so the
/// reply stays in the app.
pub(crate) fn input_body(input: &V1ThreadInput, attachments: &[Value]) -> Value {
    let mut body = serde_json::json!({
        "text": input.text,
        "clientMessageId": v1_client_message_id(input),
        "replyDelivery": "ui_only",
    });
    if !attachments.is_empty() {
        body["attachments"] = Value::Array(attachments.to_vec());
    }
    body
}

/// V1's answer to [`input_body`] as a bounded receipt.
pub(crate) fn input_receipt(
    thread: &V1Thread,
    input: &V1ThreadInput,
    status: u16,
    value: &Value,
) -> Result<V1ThreadInputReceipt, InputFailure> {
    match status {
        200..=299 => {}
        404 | 403 => return Err(InputFailure::NotFound),
        400..=499 => {
            let code = text(value, "error")
                .or_else(|| text(value, "code"))
                .filter(|c| c.len() <= 64 && c.bytes().all(|b| b.is_ascii_graphic()))
                .unwrap_or_else(|| "v1_refused".into());
            return Err(InputFailure::Refused(code));
        }
        _ => return Err(InputFailure::Unknown),
    }
    let key = v1_client_message_id(input);
    let Some(message) = value.get("message").filter(|m| m.is_object()) else {
        // Commands V1 handles without a message row (for example settings)
        // are keyed on the same client id.
        return Ok(V1ThreadInputReceipt {
            thread_id: thread.id.clone(),
            message_id: key,
            duplicate: false,
            state: "handled".into(),
        });
    };
    let duplicate = flag(message, "duplicate");
    if duplicate {
        let same_key = text(message, "clientMessageId")
            .or_else(|| text(message, "client_message_id"))
            .is_none_or(|k| k == key);
        let same_text = message
            .get("text")
            .and_then(Value::as_str)
            .is_none_or(|t| t.trim() == input.text.trim());
        if !same_key || !same_text {
            return Err(InputFailure::KeyConflict);
        }
    }
    let message_id = text(message, "id")
        .filter(|id| id.len() <= 256 && !id.chars().any(char::is_control))
        .unwrap_or(key);
    let state = text(message, "state")
        .or_else(|| text(value, "state"))
        .filter(|s| s.len() <= 64 && !s.chars().any(char::is_control))
        .unwrap_or_else(|| "queued".into());
    Ok(V1ThreadInputReceipt {
        thread_id: thread.id.clone(),
        message_id,
        duplicate,
        state,
    })
}

/// Forwards one owner input to V1. The caller has checked that the thread is
/// listed and not delegated.
pub(crate) async fn send_input(
    broker: &Broker,
    thread: &V1Thread,
    input: &V1ThreadInput,
    attachments: &[Value],
) -> Result<V1ThreadInputReceipt, InputFailure> {
    let path = format!("/api/threads/{}/ui-input", thread.id);
    match broker
        .write("POST", &path, input_body(input, attachments), MESSAGES_CAP)
        .await
    {
        Ok((status, value)) => input_receipt(thread, input, status, &value),
        Err(_) => Err(InputFailure::Unknown),
    }
}

#[cfg(test)]
#[path = "sidebar_v1_preview_tests.rs"]
mod preview_tests;
