//! Builds the owner response from the ledger: windows with model totals,
//! series and top consumers, provider headroom and pace, active sessions.
use super::{
    config::Pricing,
    ledger::{minute, Ledger, Minute, Session},
    limits,
    owners::{Directory, Owner},
    procs::Program,
};
use orkestr_v2_contracts::{
    AiActiveSession, AiConsumer, AiModelUsage, AiProcess, AiProvider, AiProviderSummary,
    AiSeries, AiTokens, AiUsageWindow, AI_USAGE_MAX_ACTIVE, AI_USAGE_MAX_CONSUMERS,
};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub(crate) const PROVIDERS: [AiProvider; 2] = [AiProvider::Claude, AiProvider::Codex];

/// (label, span minutes, step minutes)
pub(crate) const WINDOWS: [(&str, i64, i64); 3] = [("1h", 60, 1), ("24h", 1440, 15), ("7d", 10_080, 60)];

pub(crate) struct Inputs<'a> {
    pub ledger: &'a Ledger,
    pub directory: &'a Directory,
    pub pricing: &'a Pricing,
    pub programs: &'a [Program],
    pub sources: &'a [super::config::Source],
    pub now_ms: i64,
}

impl Inputs<'_> {
    pub(crate) fn account_of(&self, source: u16) -> Option<&str> {
        self.sources.get(source as usize).map(|s| s.account())
    }
    pub(crate) fn accounts_for(&self, provider: AiProvider) -> BTreeSet<String> {
        self.sources
            .iter()
            .filter(|s| s.provider == provider)
            .map(|s| s.account().to_owned())
            .collect()
    }
    fn model(&self, index: u16) -> &(AiProvider, String) {
        &self.ledger.models[index as usize]
    }
    fn cost(&self, model: u16, tokens: &AiTokens) -> Option<f64> {
        self.pricing.cost(&self.model(model).1, tokens)
    }
    fn owner(&self, session: &Session) -> Owner {
        let find = |provider: AiProvider, id: &str| self.ledger.find(provider, id).cloned();
        self.directory.resolve(session, &find)
    }
    /// Buckets from `from` (inclusive) to now.
    fn since(&self, from: Minute) -> impl Iterator<Item = (Minute, u32, u16, &AiTokens)> {
        self.ledger
            .buckets
            .range((from, 0, 0)..)
            .map(|((m, s, model), t)| (*m, *s, *model, t))
    }
}

struct OwnerTotals {
    owner: Owner,
    providers: BTreeSet<AiProvider>,
    models: BTreeSet<String>,
    roles: BTreeSet<String>,
    tokens: AiTokens,
    cost: Option<f64>,
    minutes: u32,
    sessions: BTreeSet<u32>,
}

pub(crate) fn window(inputs: &Inputs, label: &str, span: i64, step: i64) -> AiUsageWindow {
    let now = minute(inputs.now_ms);
    let points = (span / step) as usize;
    // The last point ends with the current minute.
    let from = now - points as i64 * step + 1;
    let mut by_model: BTreeMap<u16, AiTokens> = BTreeMap::new();
    let mut series: BTreeMap<u16, Vec<u64>> = BTreeMap::new();
    let mut per_session: HashMap<(u32, u16), AiTokens> = HashMap::new();
    let mut minutes: HashMap<u32, (Minute, u32)> = HashMap::new();
    for (m, s, model, t) in inputs.since(from) {
        by_model.entry(model).or_default().add(t);
        let slot = ((m - from) / step) as usize;
        let line = series.entry(model).or_insert_with(|| vec![0; points]);
        if let Some(v) = line.get_mut(slot) {
            *v += t.total();
        }
        per_session.entry((s, model)).or_default().add(t);
        let entry = minutes.entry(s).or_insert((Minute::MIN, 0));
        if entry.0 != m {
            *entry = (m, entry.1 + 1);
        }
    }
    let mut total = AiTokens::default();
    let mut cost = 0.0;
    let mut unpriced = BTreeSet::new();
    let models: Vec<AiModelUsage> = {
        let mut v: Vec<AiModelUsage> = by_model
            .iter()
            .map(|(model, tokens)| {
                total.add(tokens);
                let c = inputs.cost(*model, tokens);
                match c {
                    Some(c) => cost += c,
                    None => {
                        unpriced.insert(inputs.model(*model).1.clone());
                    }
                }
                let (provider, name) = inputs.model(*model).clone();
                AiModelUsage {
                    provider,
                    model: name,
                    tokens: *tokens,
                    cost_usd: c,
                }
            })
            .collect();
        v.sort_by_key(|m| std::cmp::Reverse(m.tokens.total()));
        v
    };
    let mut owners: HashMap<String, OwnerTotals> = HashMap::new();
    let mut resolved: HashMap<u32, Owner> = HashMap::new();
    for ((s, model), tokens) in &per_session {
        let owner = resolved
            .entry(*s)
            .or_insert_with(|| inputs.owner(&inputs.ledger.sessions[*s as usize]))
            .clone();
        let (provider, name) = inputs.model(*model).clone();
        let entry = owners.entry(owner.key.clone()).or_insert_with(|| OwnerTotals {
            owner: owner.clone(),
            providers: BTreeSet::new(),
            models: BTreeSet::new(),
            roles: BTreeSet::new(),
            tokens: AiTokens::default(),
            cost: None,
            minutes: 0,
            sessions: BTreeSet::new(),
        });
        entry.providers.insert(provider);
        entry.models.insert(name);
        if let Some(role) = &owner.role {
            entry.roles.insert(role.clone());
        }
        entry.tokens.add(tokens);
        if let Some(c) = inputs.cost(*model, tokens) {
            entry.cost = Some(entry.cost.unwrap_or(0.0) + c);
        }
        if entry.sessions.insert(*s) {
            entry.minutes += minutes.get(s).map_or(0, |m| m.1);
        }
    }
    let mut top: Vec<AiConsumer> = owners
        .into_values()
        .map(|o| AiConsumer {
            key: o.owner.key,
            kind: o.owner.kind,
            label: o.owner.label,
            link: o.owner.link,
            providers: o.providers.into_iter().collect(),
            models: o.models.into_iter().collect(),
            roles: o.roles.into_iter().collect(),
            tokens: o.tokens,
            cost_usd: o.cost,
            active_minutes: o.minutes,
            sessions: o.sessions.len() as u32,
        })
        .collect();
    top.sort_by(|a, b| {
        b.cost_usd
            .unwrap_or(0.0)
            .total_cmp(&a.cost_usd.unwrap_or(0.0))
            .then(b.tokens.total().cmp(&a.tokens.total()))
    });
    top.truncate(AI_USAGE_MAX_CONSUMERS);
    AiUsageWindow {
        range: label.into(),
        from_ms: from * 60_000,
        step_ms: step * 60_000,
        total,
        cost_usd: cost,
        unpriced_models: unpriced.into_iter().collect(),
        by_model: models,
        series: series
            .into_iter()
            .map(|(model, points)| {
                let (provider, name) = inputs.model(model).clone();
                AiSeries {
                    provider,
                    model: name,
                    points,
                }
            })
            .collect(),
        top,
    }
}

/// Tokens and API-equivalent cost of one provider since `from`.
pub(crate) fn totals(inputs: &Inputs, provider: AiProvider, from: Minute) -> (AiTokens, Option<f64>) {
    let mut tokens = AiTokens::default();
    let mut cost = None;
    for (_, _, model, t) in inputs.since(from) {
        if inputs.model(model).0 != provider {
            continue;
        }
        tokens.add(t);
        if let Some(c) = inputs.cost(model, t) {
            cost = Some(cost.unwrap_or(0.0) + c);
        }
    }
    (tokens, cost)
}

pub(crate) fn providers(inputs: &Inputs) -> Vec<AiProviderSummary> {
    let now = minute(inputs.now_ms);
    PROVIDERS
        .iter()
        .map(|provider| {
            let (recent, recent_cost) = totals(inputs, *provider, now - 29);
            AiProviderSummary {
                provider: *provider,
                limits: limits::limits(inputs, *provider),
                last_5h: totals(inputs, *provider, now - 299).0,
                last_7d: totals(inputs, *provider, now - 10_079).0,
                burn_tokens_per_minute: recent.total() as f64 / 30.0,
                burn_cost_per_hour_usd: recent_cost.map(|c| c * 2.0),
                last_activity_ms: inputs
                    .ledger
                    .sessions
                    .iter()
                    .filter(|s| s.provider == *provider && s.last_ms > 0)
                    .map(|s| s.last_ms)
                    .max(),
            }
        })
        .collect()
}

pub(crate) fn active(inputs: &Inputs) -> Vec<AiActiveSession> {
    let from = minute(inputs.now_ms) - 9;
    let mut recent: HashMap<u32, u64> = HashMap::new();
    for (_, s, _, t) in inputs.since(from) {
        *recent.entry(s).or_default() += t.total();
    }
    let mut out: Vec<AiActiveSession> = recent
        .into_iter()
        .map(|(s, tokens)| {
            let session = &inputs.ledger.sessions[s as usize];
            let owner = inputs.owner(session);
            // A program matches when it alone works in this session's directory.
            let program = session.cwd.as_ref().and_then(|cwd| {
                let mut found = inputs
                    .programs
                    .iter()
                    .filter(|p| p.provider == session.provider && p.cwd.as_ref() == Some(cwd));
                let first = found.next()?;
                found.next().is_none().then_some(first)
            });
            AiActiveSession {
                provider: session.provider,
                kind: owner.kind,
                label: owner.label,
                link: owner.link,
                role: owner.role,
                model: session.model.clone(),
                started_at_ms: session.first_ms,
                last_activity_ms: session.last_ms,
                tokens_10m: tokens,
                cpu_percent: program.map(|p| p.cpu_percent),
                rss_bytes: program.map(|p| p.rss_bytes),
            }
        })
        .collect();
    out.sort_by_key(|a| std::cmp::Reverse(a.last_activity_ms));
    out.truncate(AI_USAGE_MAX_ACTIVE);
    out
}

pub(crate) fn processes(programs: &[Program]) -> Vec<AiProcess> {
    programs
        .iter()
        .take(AI_USAGE_MAX_ACTIVE)
        .map(|p| AiProcess {
            provider: p.provider,
            label: p.label.into(),
            started_at_ms: p.started_at_ms,
            cpu_percent: p.cpu_percent,
            rss_bytes: p.rss_bytes,
            processes: p.processes,
        })
        .collect()
}
