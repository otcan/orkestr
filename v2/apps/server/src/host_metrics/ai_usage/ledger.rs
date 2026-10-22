//! Per-minute token buckets by session and model for the last eight days,
//! the sessions they belong to and plan-limit observations. Fed by the
//! scanner, read by the report; persisted as one small JSON file.
use super::parse::{LimitRecord, UsageRecord};
use orkestr_v2_contracts::{AiProvider, AiTokens};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};

/// Minutes since the Unix epoch.
pub(crate) type Minute = i64;
pub(crate) const KEEP_MINUTES: Minute = 8 * 24 * 60;
/// Limit samples kept for the pace projection.
const SAMPLE_SPAN_MS: i64 = 6 * 3_600_000;
/// Claude limit hits are kept a week to estimate the window's capacity.
const HIT_SPAN_MS: i64 = 7 * 24 * 3_600_000;

pub(crate) fn minute(t_ms: i64) -> Minute {
    t_ms.div_euclid(60_000)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Session {
    pub provider: AiProvider,
    /// Provider session id, or `agent:<id>` for a Claude helper agent.
    pub id: String,
    /// Index into the configured sources.
    pub source: u16,
    /// Server-side only: used for attribution, never sent.
    pub cwd: Option<String>,
    pub parent: Option<String>,
    pub agent: Option<String>,
    pub first_ms: i64,
    pub last_ms: i64,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct LimitTrack {
    pub provider: AiProvider,
    pub account: String,
    pub latest: LimitRecordData,
    /// (time, used percent, reset time), oldest first.
    pub samples: VecDeque<(i64, f32, Option<i64>)>,
    /// Times the provider refused requests at this limit, with the reset.
    pub hits: VecDeque<(i64, Option<i64>)>,
}

/// Serializable copy of a [`LimitRecord`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct LimitRecordData {
    pub t_ms: i64,
    pub limit_id: String,
    pub window_minutes: u32,
    pub used_percent: Option<f32>,
    pub resets_at_ms: Option<i64>,
    pub reached: bool,
}

impl From<&LimitRecord> for LimitRecordData {
    fn from(r: &LimitRecord) -> Self {
        LimitRecordData {
            t_ms: r.t_ms,
            limit_id: r.limit_id.clone(),
            window_minutes: r.window_minutes,
            used_percent: r.used_percent,
            resets_at_ms: r.resets_at_ms,
            reached: r.reached,
        }
    }
}

type BucketKey = (Minute, u32, u16);

#[derive(Debug, Default, Clone)]
pub(crate) struct Ledger {
    pub sessions: Vec<Session>,
    index: HashMap<(AiProvider, String), u32>,
    pub models: Vec<(AiProvider, String)>,
    model_index: HashMap<(AiProvider, String), u16>,
    pub buckets: BTreeMap<BucketKey, AiTokens>,
    seen: HashMap<u64, Minute>,
    pub limits: BTreeMap<(AiProvider, String, String, u32), LimitTrack>,
}

/// Compact persisted form.
#[derive(Serialize, Deserialize, Default)]
pub(crate) struct Saved {
    sessions: Vec<Session>,
    models: Vec<(AiProvider, String)>,
    /// minute, session, model, input, output, cache read, cache write, requests
    buckets: Vec<(Minute, u32, u16, u64, u64, u64, u64, u64)>,
    seen: Vec<(u64, Minute)>,
    limits: Vec<LimitTrack>,
}

impl Ledger {
    pub fn session(&mut self, provider: AiProvider, id: &str, source: u16, t_ms: i64) -> u32 {
        if let Some(i) = self.index.get(&(provider, id.to_owned())) {
            return *i;
        }
        let i = self.sessions.len() as u32;
        self.sessions.push(Session {
            provider,
            id: id.to_owned(),
            source,
            cwd: None,
            parent: None,
            agent: None,
            first_ms: t_ms,
            last_ms: 0,
            model: None,
        });
        self.index.insert((provider, id.to_owned()), i);
        i
    }

    pub fn find(&self, provider: AiProvider, id: &str) -> Option<&Session> {
        self.index
            .get(&(provider, id.to_owned()))
            .map(|i| &self.sessions[*i as usize])
    }

    fn model(&mut self, provider: AiProvider, name: &str) -> u16 {
        let key = (provider, name.to_owned());
        if let Some(i) = self.model_index.get(&key) {
            return *i;
        }
        let i = self.models.len().min(u16::MAX as usize) as u16;
        self.models.push(key.clone());
        self.model_index.insert(key, i);
        i
    }

    /// Adds one response; returns `false` for duplicates and expired records.
    pub fn record(&mut self, session: u32, rec: &UsageRecord, now_ms: i64) -> bool {
        let m = minute(rec.t_ms);
        if m < minute(now_ms) - KEEP_MINUTES || rec.t_ms > now_ms + 3_600_000 {
            return false;
        }
        if let Some(key) = rec.dedupe {
            if self.seen.insert(key, m).is_some() {
                return false;
            }
        }
        let provider = self.sessions[session as usize].provider;
        let model = self.model(provider, rec.model.as_deref().unwrap_or("unknown"));
        self.buckets
            .entry((m, session, model))
            .or_default()
            .add(&rec.tokens);
        let s = &mut self.sessions[session as usize];
        s.first_ms = s.first_ms.min(rec.t_ms);
        if rec.t_ms >= s.last_ms {
            s.last_ms = rec.t_ms;
            if rec.model.is_some() {
                s.model = rec.model.clone();
            }
        }
        true
    }

    pub fn limit(&mut self, provider: AiProvider, account: &str, rec: &LimitRecord) {
        let key = (
            provider,
            account.to_owned(),
            rec.limit_id.clone(),
            rec.window_minutes,
        );
        let track = self.limits.entry(key).or_insert_with(|| LimitTrack {
            provider,
            account: account.to_owned(),
            latest: rec.into(),
            samples: VecDeque::new(),
            hits: VecDeque::new(),
        });
        if rec.t_ms >= track.latest.t_ms {
            track.latest = rec.into();
        }
        if let Some(used) = rec.used_percent {
            let at = track.samples.partition_point(|s| s.0 <= rec.t_ms);
            track
                .samples
                .insert(at, (rec.t_ms, used, rec.resets_at_ms));
            let floor = track.latest.t_ms - SAMPLE_SPAN_MS;
            while track.samples.front().is_some_and(|s| s.0 < floor) {
                track.samples.pop_front();
            }
        }
        if rec.reached {
            let at = track.hits.partition_point(|h| h.0 <= rec.t_ms);
            track.hits.insert(at, (rec.t_ms, rec.resets_at_ms));
            let floor = track.latest.t_ms - HIT_SPAN_MS;
            while track.hits.front().is_some_and(|h| h.0 < floor) {
                track.hits.pop_front();
            }
        }
    }

    /// Forgets buckets and dedupe keys older than eight days.
    pub fn prune(&mut self, now_ms: i64) {
        let floor = minute(now_ms) - KEEP_MINUTES;
        self.buckets = self.buckets.split_off(&(floor, 0, 0));
        self.seen.retain(|_, m| *m >= floor);
    }

    pub fn save(&self) -> Saved {
        Saved {
            sessions: self.sessions.clone(),
            models: self.models.clone(),
            buckets: self
                .buckets
                .iter()
                .map(|((m, s, model), t)| {
                    (*m, *s, *model, t.input, t.output, t.cache_read, t.cache_write, t.requests)
                })
                .collect(),
            seen: self.seen.iter().map(|(k, m)| (*k, *m)).collect(),
            limits: self.limits.values().cloned().collect(),
        }
    }

    pub fn restore(saved: Saved) -> Option<Ledger> {
        let sessions = saved.sessions.len();
        let models = saved.models.len();
        let mut ledger = Ledger {
            index: saved
                .sessions
                .iter()
                .enumerate()
                .map(|(i, s)| ((s.provider, s.id.clone()), i as u32))
                .collect(),
            model_index: saved
                .models
                .iter()
                .enumerate()
                .map(|(i, m)| (m.clone(), i as u16))
                .collect(),
            sessions: saved.sessions,
            models: saved.models,
            seen: saved.seen.into_iter().collect(),
            ..Default::default()
        };
        for (m, s, model, input, output, cache_read, cache_write, requests) in saved.buckets {
            if s as usize >= sessions || model as usize >= models {
                return None;
            }
            ledger.buckets.insert(
                (m, s, model),
                AiTokens {
                    input,
                    output,
                    cache_read,
                    cache_write,
                    requests,
                },
            );
        }
        for track in saved.limits {
            let key = (
                track.provider,
                track.account.clone(),
                track.latest.limit_id.clone(),
                track.latest.window_minutes,
            );
            ledger.limits.insert(key, track);
        }
        Some(ledger)
    }
}
