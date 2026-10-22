//! Owner-only Claude and Codex usage for the host page: plan headroom, token
//! counts by model and kind, an API-equivalent cost estimate, who used the
//! tokens and what is running now. Numbers and labels only: never prompt or
//! message text, file paths or credentials.
use serde::{Deserialize, Serialize};

/// Rows in one top-consumers list.
pub const AI_USAGE_MAX_CONSUMERS: usize = 15;
/// Rows in the active-sessions and running-programs lists.
pub const AI_USAGE_MAX_ACTIVE: usize = 20;
/// Longest label, model or account name.
pub const AI_USAGE_MAX_LABEL: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProvider {
    Claude,
    Codex,
}

impl AiProvider {
    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
        }
    }
}

/// Token counts. `input` excludes cached input; cache reads and writes are
/// counted separately. `requests` is the number of model responses.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiTokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub requests: u64,
}

impl AiTokens {
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
    pub fn add(&mut self, other: &AiTokens) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.requests += other.requests;
    }
    /// Share of all input that was served from the cache, 0–100.
    pub fn cache_hit_percent(&self) -> Option<f32> {
        let all = self.input + self.cache_read + self.cache_write;
        (all > 0).then(|| (self.cache_read as f64 * 100.0 / all as f64) as f32)
    }
}

/// One plan limit (a rolling window) of a provider account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiLimit {
    pub provider: AiProvider,
    /// Account (from the operator's source labels) when several exist.
    pub account: String,
    /// Plain label, e.g. "5-hour limit" or "Weekly limit".
    pub label: String,
    pub window_minutes: u32,
    /// Used share of the window, when the provider reports it.
    pub used_percent: Option<f32>,
    pub resets_at_ms: Option<i64>,
    pub observed_at_ms: i64,
    /// The provider refused requests because this limit was reached.
    pub reached: bool,
    /// At the recent pace the limit is reached at this time (before reset).
    pub projected_full_at_ms: Option<i64>,
    /// Estimated, not reported by the provider (see `note`).
    pub estimated: bool,
    pub note: Option<String>,
    /// Start of the current window, when it is known or inferred.
    pub window_started_at_ms: Option<i64>,
    /// Tokens and API-equivalent cost in the current window so far.
    pub window_tokens: Option<u64>,
    pub window_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiProviderSummary {
    pub provider: AiProvider,
    pub limits: Vec<AiLimit>,
    pub last_5h: AiTokens,
    pub last_7d: AiTokens,
    /// All tokens per minute over the last 30 minutes.
    pub burn_tokens_per_minute: f64,
    /// API-equivalent USD per hour over the last 30 minutes.
    pub burn_cost_per_hour_usd: Option<f64>,
    pub last_activity_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiModelUsage {
    pub provider: AiProvider,
    pub model: String,
    pub tokens: AiTokens,
    /// `None` when the pricing table has no price for this model.
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiOwnerKind {
    /// A V2 conversation (Deep, Fast and Worker sessions).
    Conversation,
    /// A V1 thread.
    Thread,
    /// A coordinator session attached to a thread (or the host's own).
    Coordinator,
    /// Helper agents started by another session.
    Agent,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiConsumer {
    pub key: String,
    pub kind: AiOwnerKind,
    pub label: String,
    /// UI route (`#conversation/<id>` or `#v1/<thread>`), when one exists.
    pub link: Option<String>,
    pub providers: Vec<AiProvider>,
    pub models: Vec<String>,
    pub roles: Vec<String>,
    pub tokens: AiTokens,
    pub cost_usd: Option<f64>,
    /// Minutes with at least one model response.
    pub active_minutes: u32,
    pub sessions: u32,
}

/// Tokens per step for one provider and model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiSeries {
    pub provider: AiProvider,
    pub model: String,
    pub points: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiUsageWindow {
    /// "1h", "24h" or "7d".
    pub range: String,
    pub from_ms: i64,
    pub step_ms: i64,
    pub total: AiTokens,
    pub cost_usd: f64,
    /// Models with tokens in this window but no price.
    pub unpriced_models: Vec<String>,
    pub by_model: Vec<AiModelUsage>,
    pub series: Vec<AiSeries>,
    pub top: Vec<AiConsumer>,
}

/// A session with model responses in the last minutes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiActiveSession {
    pub provider: AiProvider,
    pub kind: AiOwnerKind,
    pub label: String,
    pub link: Option<String>,
    pub role: Option<String>,
    pub model: Option<String>,
    pub started_at_ms: i64,
    pub last_activity_ms: i64,
    pub tokens_10m: u64,
    pub cpu_percent: Option<f32>,
    pub rss_bytes: Option<u64>,
}

/// A running Claude or Codex program (with its child processes).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiProcess {
    pub provider: AiProvider,
    /// Plain description, e.g. "Codex app server" or "Claude Code".
    pub label: String,
    pub started_at_ms: Option<i64>,
    /// Share of the whole host over the last minute.
    pub cpu_percent: f32,
    pub rss_bytes: u64,
    pub processes: u32,
}

/// One configured transcript source, for the "what is counted" note.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiUsageSource {
    pub provider: AiProvider,
    pub label: String,
    pub readable: bool,
    pub files: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostAiUsage {
    pub schema_version: u32,
    /// No full pass over the transcripts has finished yet.
    pub collecting: bool,
    /// Share of the first pass done (0–100) while collecting.
    pub backfill_percent: Option<f32>,
    pub observed_at_ms: Option<i64>,
    pub interval_ms: u64,
    pub providers: Vec<AiProviderSummary>,
    pub windows: Vec<AiUsageWindow>,
    pub active: Vec<AiActiveSession>,
    pub processes: Vec<AiProcess>,
    pub sources: Vec<AiUsageSource>,
    /// Always "API-equivalent estimate": list prices, not what a plan bills.
    pub cost_basis: String,
}

impl HostAiUsage {
    pub fn is_valid(&self) -> bool {
        let short = |s: &str| s.chars().count() <= AI_USAGE_MAX_LABEL;
        self.schema_version == 1
            && self.windows.len() <= 3
            && self.active.len() <= AI_USAGE_MAX_ACTIVE
            && self.processes.len() <= AI_USAGE_MAX_ACTIVE
            && self.windows.iter().all(|w| {
                w.top.len() <= AI_USAGE_MAX_CONSUMERS
                    && w.step_ms > 0
                    && w.top.iter().all(|c| short(&c.label))
                    && w.by_model.iter().all(|m| short(&m.model))
            })
            && self.active.iter().all(|a| short(&a.label))
            && self
                .providers
                .iter()
                .all(|p| p.limits.iter().all(|l| short(&l.label) && short(&l.account)))
    }
}
