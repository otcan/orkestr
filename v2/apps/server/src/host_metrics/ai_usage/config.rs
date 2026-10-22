//! Transcript sources and the pricing table. Read from
//! `<ORKESTR_V2_HOME>/ai-usage.json` when present:
//!
//! ```json
//! {"sources": [{"provider": "codex", "label": "Main account",
//!               "path": "/home/example/.codex/sessions", "account": "main"},
//!              {"provider": "claude", "label": "Coordinator",
//!               "path": "/home/example/.claude/projects", "coordinator": true}],
//!  "pricing": {"example-model": {"input": 1.0, "output": 4.0,
//!                                "cache_read": 0.1, "cache_write": 1.25}}}
//! ```
//!
//! Without the file the service user's own `~/.claude/projects` and Codex
//! home are read. Prices are USD per million tokens at public API list
//! prices; configured prices replace or extend the built-in table.
use orkestr_v2_contracts::{AiProvider, AiTokens};
use serde::Deserialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub(crate) const CONFIG_FILE: &str = "ai-usage.json";
const MAX_SOURCES: usize = 32;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Source {
    pub provider: AiProvider,
    pub label: String,
    pub path: PathBuf,
    /// Plan account the source belongs to (limits are per account).
    #[serde(default)]
    pub account: Option<String>,
    /// Claude sessions here that nothing else claims are coordinator sessions.
    #[serde(default)]
    pub coordinator: bool,
}

impl Source {
    pub fn account(&self) -> &str {
        self.account.as_deref().unwrap_or(&self.label)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Price {
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_read: Option<f64>,
    #[serde(default)]
    pub cache_write: Option<f64>,
}

impl Price {
    const fn new(input: f64, output: f64, cache_read: f64) -> Self {
        Price {
            input,
            output,
            cache_read: Some(cache_read),
            cache_write: None,
        }
    }
    /// USD for `tokens`; cache writes default to 1.25× and reads to 0.1× input.
    pub fn cost(&self, t: &AiTokens) -> f64 {
        let read = self.cache_read.unwrap_or(self.input * 0.1);
        let write = self.cache_write.unwrap_or(self.input * 1.25);
        (t.input as f64 * self.input
            + t.output as f64 * self.output
            + t.cache_read as f64 * read
            + t.cache_write as f64 * write)
            / 1_000_000.0
    }
}

/// Public Anthropic API list prices (USD per million tokens).
const BUILT_IN: &[(&str, Price)] = &[
    ("claude-fable-5-1", Price::new(10.0, 50.0, 0.25)),
    ("claude-fable-5", Price::new(10.0, 50.0, 1.0)),
    ("claude-opus-5-5", Price::new(4.0, 20.0, 0.2)),
    ("claude-opus-5", Price::new(5.0, 25.0, 0.5)),
    ("claude-opus-4", Price::new(5.0, 25.0, 0.5)),
    ("claude-sonnet-5-5", Price::new(2.0, 10.0, 0.2)),
    ("claude-sonnet-5", Price::new(2.0, 10.0, 0.2)),
    ("claude-sonnet-4", Price::new(3.0, 15.0, 0.3)),
    ("claude-haiku-5-5", Price::new(0.1, 0.5, 0.01)),
    ("claude-haiku-4", Price::new(1.0, 5.0, 0.1)),
];

#[derive(Debug, Clone, Default)]
pub(crate) struct Pricing(HashMap<String, Price>);

impl Pricing {
    pub fn with(extra: HashMap<String, Price>) -> Self {
        let mut table: HashMap<String, Price> = BUILT_IN
            .iter()
            .map(|(m, p)| ((*m).to_owned(), *p))
            .collect();
        table.extend(extra);
        Pricing(table)
    }
    /// Exact model, else the longest configured prefix (`claude-opus-4` covers
    /// `claude-opus-4-8`).
    pub fn price(&self, model: &str) -> Option<&Price> {
        self.0.get(model).or_else(|| {
            self.0
                .iter()
                .filter(|(k, _)| model.starts_with(k.as_str()))
                .max_by_key(|(k, _)| k.len())
                .map(|(_, p)| p)
        })
    }
    pub fn cost(&self, model: &str, tokens: &AiTokens) -> Option<f64> {
        self.price(model).map(|p| p.cost(tokens))
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(default)]
    sources: Vec<Source>,
    #[serde(default)]
    pricing: HashMap<String, Price>,
}

#[derive(Debug, Clone)]
pub(crate) struct Config {
    pub sources: Vec<Source>,
    pub pricing: Pricing,
}

fn valid(source: &Source) -> bool {
    let label = source.label.chars().count();
    (1..=60).contains(&label)
        && !source.label.chars().any(char::is_control)
        && source.account().chars().count() <= 60
        && source.path.is_absolute()
}

fn price_ok(p: &Price) -> bool {
    [Some(p.input), Some(p.output), p.cache_read, p.cache_write]
        .into_iter()
        .flatten()
        .all(|v| v.is_finite() && (0.0..=10_000.0).contains(&v))
}

pub(crate) fn parse(raw: &[u8]) -> Option<Config> {
    let file: File = serde_json::from_slice(raw).ok()?;
    (file.sources.len() <= MAX_SOURCES
        && file.sources.iter().all(valid)
        && file.pricing.values().all(price_ok)
        && file.pricing.keys().all(|k| !k.is_empty() && k.len() <= 120))
    .then(|| Config {
        sources: file.sources,
        pricing: Pricing::with(file.pricing),
    })
}

/// The user's own Claude and Codex homes.
pub(crate) fn defaults(env: &dyn Fn(&str) -> Option<String>) -> Vec<Source> {
    let mut out = Vec::new();
    let home = env("HOME").map(PathBuf::from);
    if let Some(home) = &home {
        out.push(Source {
            provider: AiProvider::Claude,
            label: "Claude Code".into(),
            path: home.join(".claude/projects"),
            account: None,
            coordinator: true,
        });
    }
    let codex = env("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home.map(|h| h.join(".codex")));
    if let Some(codex) = codex {
        for dir in ["sessions", "archived_sessions"] {
            out.push(Source {
                provider: AiProvider::Codex,
                label: "Codex".into(),
                path: codex.join(dir),
                account: None,
                coordinator: false,
            });
        }
    }
    out
}

/// A missing file means the defaults; an invalid one is ignored as a whole.
pub(crate) fn load(home: &Path) -> Config {
    let parsed = std::fs::read(home.join(CONFIG_FILE))
        .ok()
        .and_then(|raw| parse(&raw));
    parsed.unwrap_or_else(|| Config {
        sources: defaults(&|k| std::env::var(k).ok()),
        pricing: Pricing::with(HashMap::new()),
    })
}
