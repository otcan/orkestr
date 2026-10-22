//! Plan headroom. Codex reports its windows' used share with every response;
//! the pace over the last hour projects when a window fills. Claude reports
//! a limit only when it refuses a request, so its 5-hour window is inferred
//! from activity and sized from the last time the limit was reached.
use super::{
    ledger::{minute, LimitTrack, Minute},
    report::Inputs,
};
use orkestr_v2_contracts::{AiLimit, AiProvider};
use std::collections::{BTreeMap, BTreeSet};

const HOUR_MS: i64 = 3_600_000;
const FIVE_HOURS: Minute = 300;

fn window_label(minutes: u32, limit_id: &str) -> String {
    let base = match minutes {
        300 => "5-hour limit".to_owned(),
        10_080 => "Weekly limit".to_owned(),
        m if m % 60 == 0 => format!("{}-hour limit", m / 60),
        m => format!("{m}-minute limit"),
    };
    let family = limit_id.trim_start_matches("codex").trim_start_matches('_');
    if family.is_empty() || matches!(limit_id, "five_hour" | "seven_day") {
        base
    } else {
        format!("{base} · {family}")
    }
}

/// When the recent pace fills the window, if before it resets.
pub(crate) fn projection(track: &LimitTrack) -> Option<i64> {
    let latest = &track.latest;
    let used = latest.used_percent?;
    let same_window = |r: Option<i64>| match (r, latest.resets_at_ms) {
        (Some(a), Some(b)) => (a - b).abs() <= 120_000,
        (None, None) => true,
        _ => false,
    };
    let first = track
        .samples
        .iter()
        .find(|s| s.0 >= latest.t_ms - HOUR_MS && same_window(s.2))?;
    let span = latest.t_ms - first.0;
    let rise = used - first.1;
    if span < 10 * 60_000 || rise <= 0.0 || used >= 100.0 {
        return None;
    }
    let eta = latest.t_ms + ((100.0 - used) as f64 / rise as f64 * span as f64) as i64;
    latest.resets_at_ms.is_none_or(|r| eta < r).then_some(eta)
}

fn codex(inputs: &Inputs) -> Vec<AiLimit> {
    let mut out = Vec::new();
    for track in inputs.ledger.limits.values() {
        let l = &track.latest;
        if track.provider != AiProvider::Codex
            || l.t_ms < inputs.now_ms - 7 * 24 * HOUR_MS
            || (l.limit_id != "codex" && l.t_ms < inputs.now_ms - 24 * HOUR_MS)
        {
            continue;
        }
        let expired = l.resets_at_ms.is_some_and(|r| r <= inputs.now_ms);
        out.push(AiLimit {
            provider: AiProvider::Codex,
            account: track.account.clone(),
            label: window_label(l.window_minutes, &l.limit_id),
            window_minutes: l.window_minutes,
            used_percent: if expired { None } else { l.used_percent },
            resets_at_ms: l.resets_at_ms.filter(|_| !expired),
            observed_at_ms: l.t_ms,
            reached: l.reached && !expired,
            projected_full_at_ms: if expired { None } else { projection(track) },
            estimated: false,
            note: expired.then(|| "The window has reset since the last Codex reply".into()),
            window_started_at_ms: l
                .resets_at_ms
                .filter(|_| !expired)
                .map(|r| r - i64::from(l.window_minutes) * 60_000),
            window_tokens: None,
            window_cost_usd: None,
        });
    }
    out.sort_by_key(|l| (l.account.clone(), l.label.contains('·'), l.window_minutes));
    out
}

/// Claude cost and tokens per minute of one account, oldest first.
fn claude_minutes(inputs: &Inputs, account: &str) -> BTreeMap<Minute, (f64, u64)> {
    let from = minute(inputs.now_ms) - 10_080 - FIVE_HOURS;
    let mut out: BTreeMap<Minute, (f64, u64)> = BTreeMap::new();
    for ((m, s, model), t) in inputs.ledger.buckets.range((from, 0, 0)..) {
        let session = &inputs.ledger.sessions[*s as usize];
        if session.provider != AiProvider::Claude
            || inputs.account_of(session.source) != Some(account)
        {
            continue;
        }
        let entry = out.entry(*m).or_default();
        entry.0 += inputs.pricing.cost(&inputs.ledger.models[*model as usize].1, t).unwrap_or(0.0);
        entry.1 += t.total();
    }
    out
}

/// 5-hour windows: each starts at the hour of the first activity after the
/// previous one ended, unless a reported reset time anchors it.
fn blocks(active: &BTreeMap<Minute, (f64, u64)>, anchors: &[Minute]) -> Vec<Minute> {
    let mut starts = Vec::new();
    let mut end = Minute::MIN;
    for m in active.keys() {
        if *m < end {
            continue;
        }
        let start = anchors
            .iter()
            .map(|r| r - FIVE_HOURS)
            .find(|s| *s <= *m && *m < s + FIVE_HOURS)
            .unwrap_or(m - m.rem_euclid(60));
        starts.push(start);
        end = start + FIVE_HOURS;
    }
    starts
}

fn claude(inputs: &Inputs) -> Vec<AiLimit> {
    let now = inputs.now_ms;
    let accounts: BTreeSet<String> = inputs.accounts_for(AiProvider::Claude);
    let mut out = Vec::new();
    for account in &accounts {
        let track = |id: &str| {
            inputs
                .ledger
                .limits
                .get(&(AiProvider::Claude, account.clone(), id.to_owned(), if id == "five_hour" { 300 } else { 10_080 }))
        };
        let active = claude_minutes(inputs, account);
        if active.is_empty() && track("five_hour").is_none() {
            continue;
        }
        let hits: Vec<(i64, Option<i64>)> = track("five_hour")
            .map(|t| t.hits.iter().copied().collect())
            .unwrap_or_default();
        let anchors: Vec<Minute> = hits.iter().filter_map(|h| h.1).map(minute).collect();
        let starts = blocks(&active, &anchors);
        let now_m = minute(now);
        let current = starts.last().copied().filter(|s| now_m < s + FIVE_HOURS);
        let sum = |from: Minute, to: Minute| {
            active
                .range(from..=to)
                .fold((0.0, 0u64), |a, (_, v)| (a.0 + v.0, a.1 + v.1))
        };
        let (cost, tokens) = current.map(|s| sum(s, now_m)).unwrap_or_default();
        // Capacity: what the window had used when the limit was last reached.
        let capacity = hits.last().and_then(|(t, reset)| {
            let hit = minute(*t);
            let start = reset
                .map(|r| minute(r) - FIVE_HOURS)
                .or_else(|| starts.iter().rev().find(|s| **s <= hit).copied())?;
            let used = sum(start, hit).0;
            (used > 0.0).then_some((used, *t))
        });
        let refused = hits
            .last()
            .filter(|(t, reset)| reset.is_some_and(|r| r > now) && *t > now - 5 * HOUR_MS)
            .copied();
        let recent = sum(now_m - 29, now_m).0 / 30.0;
        let resets = refused
            .and_then(|r| r.1)
            .or(current.map(|s| (s + FIVE_HOURS) * 60_000));
        let used_percent = match (refused, capacity) {
            (Some(_), _) => Some(100.0),
            (None, Some((cap, _))) if current.is_some() => Some((cost / cap * 100.0).min(100.0) as f32),
            _ => None,
        };
        let projected = match (refused, capacity, current) {
            (None, Some((cap, _)), Some(start)) if recent > 0.0 && cost < cap => {
                let eta = now + ((cap - cost) / recent * 60_000.0) as i64;
                (eta < (start + FIVE_HOURS) * 60_000).then_some(eta)
            }
            _ => None,
        };
        let note = match (refused, capacity) {
            (Some(_), _) => "Claude refused requests: the limit is reached until the reset".to_owned(),
            (None, Some((_, at))) => format!("Estimated: compared with the API-equivalent cost used when the limit was last reached ({})", super::date_label(at)),
            (None, None) => "Claude does not report usage until the limit is reached; this shows the current window's activity".to_owned(),
        };
        out.push(AiLimit {
            provider: AiProvider::Claude,
            account: account.clone(),
            label: "5-hour limit".into(),
            window_minutes: 300,
            used_percent,
            resets_at_ms: resets,
            observed_at_ms: refused.map(|r| r.0).unwrap_or(now),
            reached: refused.is_some(),
            projected_full_at_ms: projected,
            estimated: refused.is_none(),
            note: Some(note),
            window_started_at_ms: current.map(|s| s * 60_000),
            window_tokens: current.map(|_| tokens),
            window_cost_usd: current.map(|_| cost),
        });
        if let Some(week) = track("seven_day") {
            let last = week.hits.back().copied();
            if let Some((t, Some(reset))) = last.filter(|h| h.1.is_some_and(|r| r > now)) {
                out.push(AiLimit {
                    provider: AiProvider::Claude,
                    account: account.clone(),
                    label: "Weekly limit".into(),
                    window_minutes: 10_080,
                    used_percent: Some(100.0),
                    resets_at_ms: Some(reset),
                    observed_at_ms: t,
                    reached: true,
                    projected_full_at_ms: None,
                    estimated: false,
                    note: Some("Claude refused requests: the weekly limit is reached until the reset".into()),
                    window_started_at_ms: None,
                    window_tokens: None,
                    window_cost_usd: None,
                });
            }
        }
    }
    out
}

pub(crate) fn limits(inputs: &Inputs, provider: AiProvider) -> Vec<AiLimit> {
    match provider {
        AiProvider::Codex => codex(inputs),
        AiProvider::Claude => claude(inputs),
    }
}
