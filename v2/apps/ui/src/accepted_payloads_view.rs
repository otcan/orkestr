//! Reads the texts of accepted answers for the chat (ORK-797): one request for
//! many answers, kept for the rest of the page, and quiet retries with
//! backoff and jitter when the server is busy. Nothing here polls: a text that
//! has been read is never read again.
use crate::accepted_results_bridge::{start, start_batch};
use dioxus::prelude::*;
use orkestr_v2_contracts::{AcceptedResult, ProviderPayload, ProviderPayloads, RunId};
use orkestr_v2_ui::{
    accepted_payloads::{
        answer as answer_for, batches, retry_window_ms, sort_batch, wanted, Answer, PayloadCache,
        ATTEMPTS,
    },
    accepted_results::bound_payload,
    live_answer::LiveAnswer,
    payload::silent_assistant_reply,
    session_scope::SessionScope,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
};

thread_local! {
    /// Texts read on this page: kept across re-renders, stream reconnects and
    /// switching chats, dropped when the session changes.
    static CACHE: RefCell<PayloadCache> = RefCell::new(PayloadCache::default());
}

fn with_cache<T>(generation: u64, f: impl FnOnce(&mut PayloadCache) -> T) -> T {
    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        cache.scope(generation);
        f(&mut cache)
    })
}

/// The owner removed this text on this page: it is never shown again.
pub fn removed(conversation: &str, payload: &str) {
    CACHE.with(|cache| cache.borrow_mut().removed(conversation, payload));
}

/// What each reply in `rows` shows, by acceptance sequence.
pub fn answers(
    generation: u64,
    conversation: &str,
    rows: &[AcceptedResult],
    failed: &BTreeSet<String>,
) -> BTreeMap<i64, Answer> {
    with_cache(generation, |cache| {
        rows.iter()
            .map(|row| {
                let failed = row
                    .payload_id
                    .as_ref()
                    .is_some_and(|payload| failed.contains(&payload.to_string()));
                (
                    row.acceptance_sequence,
                    answer_for(conversation, row, cache, failed),
                )
            })
            .collect()
    })
}

/// The chat state a read reports to.
#[derive(Clone, Copy)]
pub struct Reader {
    pub generation: u64,
    pub mounted: Signal<bool>,
    pub session_scope: Signal<SessionScope>,
    pub channel: Signal<Option<document::Eval>>,
    /// Bumped when texts arrive, so the chat draws them.
    pub loaded: Signal<u64>,
    /// Payload IDs whose every read failed.
    pub failed: Signal<BTreeSet<String>>,
    pub silent: Signal<BTreeSet<i64>>,
    pub answer: Signal<LiveAnswer>,
    pub onexpired: EventHandler<()>,
}

impl Reader {
    fn settle(mut self, run: &RunId) {
        if !self.answer.peek().is_settled(run) {
            self.answer.write().settle(run);
        }
    }
    /// A reply can show its text (or that it was removed); a suppression
    /// marker hides the reply instead.
    fn shown(mut self, row: &AcceptedResult, payload: &ProviderPayload) {
        if payload.text.as_deref().is_some_and(silent_assistant_reply)
            && !self.silent.peek().contains(&row.acceptance_sequence)
        {
            self.silent.write().insert(row.acceptance_sequence);
        }
        self.settle(&row.run_id);
    }
    fn keep(mut self, row: &AcceptedResult, payload: ProviderPayload) {
        let id = payload.payload_id.to_string();
        with_cache(self.generation, |cache| cache.insert(payload.clone()));
        if self.failed.peek().contains(&id) {
            self.failed.write().remove(&id);
        }
        self.shown(row, &payload);
        let next = *self.loaded.peek() + 1;
        self.loaded.set(next);
    }
    fn fail(mut self, row: &AcceptedResult) {
        if let Some(payload) = row.payload_id.as_ref().map(ToString::to_string) {
            if !self.failed.peek().contains(&payload) {
                self.failed.write().insert(payload);
            }
        }
    }
    fn current(&self) -> bool {
        (self.mounted)() && self.session_scope.read().is_current(self.generation)
    }
    /// Stops a read still running from an earlier pass.
    pub fn stop(&self) {
        if let Some(eval) = self.channel.peek().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    }

    /// Before reading: replies with nothing to read are settled, replies read
    /// before are shown from the cache, and the rest is returned to read.
    pub fn plan(self, conversation: &str, rows: &[AcceptedResult]) -> Vec<AcceptedResult> {
        let (cached, todo) = with_cache(self.generation, |cache| {
            let cached: Vec<_> = rows
                .iter()
                .filter_map(|row| Some((row.clone(), cache.get(conversation, row)?.clone())))
                .collect();
            (cached, wanted(conversation, rows, cache))
        });
        for row in rows
            .iter()
            .filter(|row| row.payload_removed || row.payload_id.is_none())
        {
            self.settle(&row.run_id);
        }
        for (row, payload) in &cached {
            self.shown(row, payload);
        }
        todo
    }

    /// Reads `rows`' texts: in batches first, then one by one for what a
    /// batch left out. Busy answers are retried with backoff; text already
    /// on screen is never touched.
    pub async fn read(self, conversation: String, rows: Vec<AcceptedResult>) {
        self.stop();
        let mut alone = Vec::new();
        for asked in batches(&rows) {
            let ids: Vec<String> = asked
                .iter()
                .filter_map(|row| row.payload_id.as_ref().map(ToString::to_string))
                .collect();
            let mut failures = 0;
            loop {
                let eval = start_batch(json!({"conversation":conversation,"payloads":ids}));
                let Some(reply) = self.request(eval).await else {
                    return;
                };
                match reply {
                    Reply::Text(text) => {
                        match serde_json::from_str::<ProviderPayloads>(&text) {
                            Ok(answer) => {
                                let sorted = sort_batch(&conversation, &asked, &answer);
                                for (row, payload) in sorted.read {
                                    self.keep(&row, payload);
                                }
                                alone.extend(sorted.alone);
                            }
                            Err(_) => alone.extend(asked.iter().cloned()),
                        }
                        break;
                    }
                    Reply::Status(401 | 403) => {
                        self.onexpired.call(());
                        return;
                    }
                    // A server without batch reads (or a refused batch):
                    // read each answer alone.
                    Reply::Status(status)
                        if (400..500).contains(&status) && !matches!(status, 408 | 429) =>
                    {
                        alone.extend(asked.iter().cloned());
                        break;
                    }
                    Reply::Status(_) | Reply::Failed => {
                        failures += 1;
                        if failures >= ATTEMPTS {
                            for row in &asked {
                                self.fail(row);
                            }
                            break;
                        }
                        backoff(failures).await;
                    }
                }
            }
        }
        for row in alone {
            if !self.read_alone(&conversation, &row).await {
                return;
            }
        }
    }

    /// One answer's text. False when the page or session ended.
    async fn read_alone(self, conversation: &str, row: &AcceptedResult) -> bool {
        let Some(payload) = row.payload_id.as_ref().map(ToString::to_string) else {
            return true;
        };
        let mut failures = 0;
        loop {
            let eval = start(json!({"conversation":conversation,"payload":payload}), true);
            let Some(reply) = self.request(eval).await else {
                return false;
            };
            match reply {
                Reply::Text(text) => {
                    match serde_json::from_str::<ProviderPayload>(&text) {
                        Ok(read) if bound_payload(row, conversation, &read) => self.keep(row, read),
                        // Not this reply's text: it can never show it.
                        _ => {
                            self.fail(row);
                            self.settle(&row.run_id);
                        }
                    }
                    return true;
                }
                Reply::Status(401 | 403) => {
                    self.onexpired.call(());
                    return false;
                }
                Reply::Status(_) | Reply::Failed => {
                    failures += 1;
                    if failures >= ATTEMPTS {
                        self.fail(row);
                        return true;
                    }
                    backoff(failures).await;
                }
            }
        }
    }

    async fn request(self, eval: document::Eval) -> Option<Reply> {
        let mut channel = self.channel;
        channel.set(Some(eval));
        let result = eval.join::<Value>().await;
        if !self.current() {
            return None;
        }
        channel.set(None);
        Some(match result {
            Ok(value) if value["status"] == 200 => {
                Reply::Text(value["text"].as_str().unwrap_or("").to_owned())
            }
            Ok(value) => Reply::Status(value["status"].as_u64().unwrap_or(0)),
            Err(_) => Reply::Failed,
        })
    }
}

enum Reply {
    Text(String),
    Status(u64),
    Failed,
}

/// A random wait within the retry window, so open chats do not retry in step.
async fn backoff(failures: u32) {
    let (low, high) = retry_window_ms(failures);
    let _ = document::eval(&format!(
        "await new Promise(resolve => setTimeout(resolve, {low} + Math.floor(Math.random() * {}))); return null;",
        high - low
    ))
    .await;
}
