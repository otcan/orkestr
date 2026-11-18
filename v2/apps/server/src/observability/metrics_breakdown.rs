//! Response sizes and the per-conversation breakdown of the JSON summary.
use super::{round, Sample, Series};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    time::{Duration, Instant},
};
use uuid::Uuid;

/// Conversations listed in a summary, and routes listed per conversation.
const CONVERSATIONS_MAX: usize = 20;
const CONVERSATION_ROUTES_MAX: usize = 5;

pub(super) struct Sizes {
    pub bytes_p50: Option<u64>,
    pub bytes_max: Option<u64>,
    pub bytes_total: u64,
    pub rows_total: u64,
}

/// Response sizes of some samples: bytes median, maximum and total (over
/// the responses whose size was known) and the rows reported.
pub(super) fn sizes<'a>(samples: impl Iterator<Item = &'a Sample>) -> Sizes {
    let mut bytes = Vec::new();
    let mut rows_total = 0_u64;
    for sample in samples {
        bytes.extend(sample.bytes.map(u64::from));
        rows_total += sample.rows.map_or(0, u64::from);
    }
    bytes.sort_unstable();
    Sizes {
        bytes_p50: (!bytes.is_empty()).then(|| bytes[(bytes.len() - 1) / 2]),
        bytes_max: bytes.last().copied(),
        bytes_total: bytes.iter().sum(),
        rows_total,
    }
}

/// The conversations with the most request time in the window (static
/// assets and conversation-less routes excluded): requests, time, bytes and
/// rows, and their busiest routes. A chat that opens with dozens of
/// sequential reads shows up here as one conversation with a high count.
pub(super) fn conversations(
    map: &BTreeMap<(String, String), Series>,
    window: Duration,
    now: Instant,
) -> Vec<Value> {
    #[derive(Default)]
    struct Total<'a> {
        requests: u64,
        micros: u64,
        max: u64,
        bytes: u64,
        rows: u64,
        /// (method, route) -> (count, micros, bytes)
        routes: BTreeMap<(&'a str, &'a str), (u64, u64, u64)>,
    }
    let mut totals: HashMap<Uuid, Total<'_>> = HashMap::new();
    for ((method, route), series) in map {
        for sample in series.in_window(window, now) {
            let Some(conversation) = sample.conversation else {
                continue;
            };
            let bytes = sample.bytes.map_or(0, u64::from);
            let total = totals.entry(conversation).or_default();
            total.requests += 1;
            total.micros = total.micros.saturating_add(sample.micros);
            total.max = total.max.max(sample.micros);
            total.bytes += bytes;
            total.rows += sample.rows.map_or(0, u64::from);
            let entry = total
                .routes
                .entry((method.as_str(), route.as_str()))
                .or_default();
            entry.0 += 1;
            entry.1 = entry.1.saturating_add(sample.micros);
            entry.2 += bytes;
        }
    }
    let mut totals: Vec<_> = totals.into_iter().collect();
    totals.sort_by(|a, b| b.1.micros.cmp(&a.1.micros).then(a.0.cmp(&b.0)));
    totals
        .into_iter()
        .take(CONVERSATIONS_MAX)
        .map(|(conversation, total)| {
            let mut routes: Vec<_> = total.routes.into_iter().collect();
            routes.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.0.cmp(&b.0)));
            json!({
                "conversation": conversation.to_string(),
                "requests": total.requests,
                "total_ms": round(total.micros as f64 / 1000.0),
                "max_ms": round(total.max as f64 / 1000.0),
                "bytes": total.bytes,
                "rows": total.rows,
                "routes": routes
                    .into_iter()
                    .take(CONVERSATION_ROUTES_MAX)
                    .map(|((method, route), (count, micros, bytes))| json!({
                        "method": method, "route": route, "count": count,
                        "total_ms": round(micros as f64 / 1000.0), "bytes": bytes,
                    }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect()
}
