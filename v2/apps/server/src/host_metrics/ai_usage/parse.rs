//! Line parsers for Claude Code transcripts and Codex session rollouts.
//! Only token counts, models, timestamps, session identity and plan-limit
//! numbers are read; message and tool content is skipped by the typed
//! deserializers and never stored.
use crate::live_map::timestamp_ms;
use orkestr_v2_contracts::AiTokens;
use serde::Deserialize;

/// A plan-limit observation from a transcript.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LimitRecord {
    pub t_ms: i64,
    /// Provider limit family (`codex`, `five_hour`, …).
    pub limit_id: String,
    pub window_minutes: u32,
    pub used_percent: Option<f32>,
    pub resets_at_ms: Option<i64>,
    pub reached: bool,
}

/// Token usage of one model response.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct UsageRecord {
    pub t_ms: i64,
    pub model: Option<String>,
    pub tokens: AiTokens,
    /// Claude repeats a response's usage on each content block line.
    pub dedupe: Option<u64>,
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn hash(parts: &[&str]) -> u64 {
    // FNV-1a: stable across restarts (persisted dedupe keys).
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for b in part.bytes().chain(std::iter::once(0)) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    h
}

fn bounded(value: Option<String>) -> Option<String> {
    value.filter(|v| {
        !v.is_empty() && v.len() <= 120 && !v.chars().any(|c| c.is_control() || c == '/')
    })
}

// ---------------------------------------------------------------- Claude

#[derive(Deserialize, Default)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<ClaudeUsage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeQuota {
    resets_at: Option<f64>,
    rate_limit_type: Option<String>,
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeLineRaw {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    session_id: Option<String>,
    agent_id: Option<String>,
    attribution_agent: Option<String>,
    cwd: Option<String>,
    request_id: Option<String>,
    message: Option<ClaudeMessage>,
    quota_limits: Option<ClaudeQuota>,
}

/// What one Claude transcript line contributes.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ClaudeLine {
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub cwd: Option<String>,
    pub usage: Option<UsageRecord>,
    pub limit: Option<LimitRecord>,
}

fn claude_window(kind: &str) -> Option<(&'static str, u32)> {
    match kind {
        "five_hour" => Some(("five_hour", 300)),
        "seven_day" | "seven_day_opus" | "seven_day_sonnet" => Some(("seven_day", 10_080)),
        _ => None,
    }
}

pub(crate) fn claude_line(line: &[u8]) -> Option<ClaudeLine> {
    let usage_line = contains(line, b"\"usage\"") && contains(line, b"\"assistant\"");
    let quota_line = contains(line, b"\"quotaLimits\"");
    if !usage_line && !quota_line {
        return None;
    }
    let raw: ClaudeLineRaw = serde_json::from_slice(line).ok()?;
    let t_ms = raw.timestamp.as_deref().and_then(timestamp_ms)?;
    let mut out = ClaudeLine {
        session_id: bounded(raw.session_id),
        agent_id: bounded(raw.agent_id),
        agent_type: bounded(raw.attribution_agent),
        cwd: raw.cwd.filter(|c| c.len() <= 4096),
        ..Default::default()
    };
    if let Some(q) = raw.quota_limits {
        if let Some((id, minutes)) = q.rate_limit_type.as_deref().and_then(claude_window) {
            out.limit = Some(LimitRecord {
                t_ms,
                limit_id: id.into(),
                window_minutes: minutes,
                used_percent: None,
                resets_at_ms: q.resets_at.map(|s| (s * 1000.0) as i64).filter(|t| *t > 0),
                reached: q.status.as_deref() != Some("allowed"),
            });
        }
    }
    if raw.kind.as_deref() == Some("assistant") {
        if let Some(message) = raw.message {
            let model = bounded(message.model).filter(|m| !m.starts_with('<'));
            if let (Some(u), Some(model)) = (message.usage, model) {
                let tokens = AiTokens {
                    input: u.input_tokens,
                    output: u.output_tokens,
                    cache_read: u.cache_read_input_tokens,
                    cache_write: u.cache_creation_input_tokens,
                    requests: 1,
                };
                let dedupe = message.id.as_deref().map(|id| {
                    hash(&[id, raw.request_id.as_deref().unwrap_or("")])
                });
                if tokens.total() > 0 {
                    out.usage = Some(UsageRecord {
                        t_ms,
                        model: Some(model),
                        tokens,
                        dedupe,
                    });
                }
            }
        }
    }
    Some(out)
}

// ---------------------------------------------------------------- Codex

#[derive(Deserialize, Clone, Copy, Default, PartialEq, Eq, Debug, serde::Serialize)]
pub(crate) struct CodexUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    #[serde(default)]
    pub cache_write_input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

impl CodexUsage {
    /// OpenAI counts cached input inside `input_tokens`.
    fn tokens(self) -> AiTokens {
        AiTokens {
            input: self
                .input_tokens
                .saturating_sub(self.cached_input_tokens)
                .saturating_sub(self.cache_write_input_tokens),
            output: self.output_tokens,
            cache_read: self.cached_input_tokens,
            cache_write: self.cache_write_input_tokens,
            requests: 1,
        }
    }
    fn minus(self, before: CodexUsage) -> CodexUsage {
        CodexUsage {
            input_tokens: self.input_tokens.saturating_sub(before.input_tokens),
            cached_input_tokens: self
                .cached_input_tokens
                .saturating_sub(before.cached_input_tokens),
            cache_write_input_tokens: self
                .cache_write_input_tokens
                .saturating_sub(before.cache_write_input_tokens),
            output_tokens: self.output_tokens.saturating_sub(before.output_tokens),
        }
    }
}

#[derive(Deserialize)]
struct CodexInfo {
    total_token_usage: Option<CodexUsage>,
    last_token_usage: Option<CodexUsage>,
}

#[derive(Deserialize)]
struct CodexWindow {
    used_percent: Option<f32>,
    window_minutes: Option<u32>,
    resets_at: Option<f64>,
}

#[derive(Deserialize)]
struct CodexLimits {
    limit_id: Option<String>,
    primary: Option<CodexWindow>,
    secondary: Option<CodexWindow>,
    rate_limit_reached_type: Option<String>,
}

#[derive(Deserialize)]
struct CodexPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    // session_meta
    id: Option<String>,
    cwd: Option<String>,
    parent_thread_id: Option<String>,
    forked_from_id: Option<String>,
    agent_nickname: Option<String>,
    subagent_history_start_ordinal: Option<u64>,
    // turn_context
    model: Option<String>,
    // token_count
    info: Option<CodexInfo>,
    rate_limits: Option<CodexLimits>,
}

#[derive(Deserialize)]
struct CodexLineRaw {
    timestamp: Option<String>,
    ordinal: Option<u64>,
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<CodexPayload>,
}

/// Session identity from a rollout's `session_meta` line.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct CodexMeta {
    pub id: String,
    pub cwd: Option<String>,
    pub parent: Option<String>,
    pub agent: Option<String>,
}

/// Per-file parser state, persisted with the file cursor.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct CodexState {
    pub model: Option<String>,
    pub last_total: Option<CodexUsage>,
    /// A fork copies its parent's history up to this ordinal: not counted.
    pub skip_before: Option<u64>,
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct CodexLine {
    pub meta: Option<CodexMeta>,
    pub usage: Option<UsageRecord>,
    pub limits: Vec<LimitRecord>,
}

fn head(line: &[u8]) -> &[u8] {
    &line[..line.len().min(240)]
}

impl CodexState {
    pub(crate) fn line(&mut self, line: &[u8]) -> Option<CodexLine> {
        let h = head(line);
        let token = contains(h, b"token_count");
        let meta = contains(h, b"session_meta");
        let turn = contains(h, b"turn_context");
        if !token && !meta && !turn {
            return None;
        }
        let raw: CodexLineRaw = serde_json::from_slice(line).ok()?;
        let payload = raw.payload?;
        let t_ms = raw.timestamp.as_deref().and_then(timestamp_ms);
        let mut out = CodexLine::default();
        match (raw.kind.as_deref(), payload.kind.as_deref()) {
            (Some("session_meta"), _) => {
                let id = bounded(payload.id)?;
                self.skip_before = payload.subagent_history_start_ordinal;
                out.meta = Some(CodexMeta {
                    id,
                    cwd: payload.cwd.filter(|c| c.len() <= 4096),
                    parent: bounded(payload.parent_thread_id.or(payload.forked_from_id)),
                    agent: bounded(payload.agent_nickname).map(|_| "agent".to_owned()),
                });
            }
            (Some("turn_context"), _) => {
                if let Some(model) = bounded(payload.model) {
                    self.model = Some(model);
                }
            }
            (Some("event_msg"), Some("token_count")) => {
                let t_ms = t_ms?;
                let copied = matches!((self.skip_before, raw.ordinal), (Some(s), Some(o)) if o < s);
                if let Some(limits) = payload.rate_limits {
                    let id = bounded(limits.limit_id).unwrap_or_else(|| "codex".into());
                    let reached = limits.rate_limit_reached_type.is_some();
                    for w in [limits.primary, limits.secondary].into_iter().flatten() {
                        let Some(minutes) = w.window_minutes.filter(|m| *m > 0) else {
                            continue;
                        };
                        out.limits.push(LimitRecord {
                            t_ms,
                            limit_id: id.clone(),
                            window_minutes: minutes,
                            used_percent: w.used_percent.filter(|p| p.is_finite()),
                            resets_at_ms: w.resets_at.map(|s| (s * 1000.0) as i64),
                            reached: reached
                                || w.used_percent.is_some_and(|p| p >= 100.0),
                        });
                    }
                    if copied {
                        out.limits.clear();
                    }
                }
                if let Some(info) = payload.info {
                    let previous = self.last_total;
                    if let Some(total) = info.total_token_usage {
                        self.last_total = Some(total);
                    }
                    let unchanged = info.total_token_usage.is_some() && info.total_token_usage == previous;
                    let usage = match (info.last_token_usage, info.total_token_usage, previous) {
                        _ if unchanged || copied => None,
                        (Some(last), _, _) => Some(last),
                        (None, Some(total), Some(before)) => Some(total.minus(before)),
                        (None, Some(total), None) => Some(total),
                        (None, None, _) => None,
                    };
                    if let Some(usage) = usage {
                        let tokens = usage.tokens();
                        if tokens.total() > 0 {
                            out.usage = Some(UsageRecord {
                                t_ms,
                                model: self.model.clone(),
                                tokens,
                                dedupe: None,
                            });
                        }
                    }
                }
            }
            _ => return None,
        }
        Some(out)
    }
}
