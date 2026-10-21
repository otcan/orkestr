//! One JSON line per request on stderr (journald). Only ids, route
//! templates, statuses and durations: never bodies, queries or credentials.
use super::context::UpstreamCall;
use serde_json::{json, Value};
use std::{io::Write, time::Duration};

pub(super) struct RequestLine<'a> {
    pub id: &'a str,
    pub method: &'a str,
    pub route: &'a str,
    pub status: u16,
    pub elapsed: Duration,
    pub slow: bool,
    pub streaming: bool,
    pub upstream: &'a [UpstreamCall],
    pub spans: &'a [(&'static str, Duration)],
}

fn ms(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 10_000.0).round() / 10.0
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub(super) fn line(entry: &RequestLine<'_>) -> Value {
    let mut value = json!({
        "ts": now_ms(),
        "level": if entry.slow || entry.status >= 500 { "warn" } else { "info" },
        "msg": if entry.slow { "slow_request" } else { "request" },
        "rid": entry.id,
        "method": entry.method,
        "route": entry.route,
        "status": entry.status,
        "ms": ms(entry.elapsed),
    });
    if entry.streaming {
        value["stream"] = json!(true);
    }
    if !entry.upstream.is_empty() {
        value["upstream"] = entry
            .upstream
            .iter()
            .map(|c| json!({"target": c.target, "route": c.route, "status": c.status, "ms": ms(c.elapsed)}))
            .collect();
        value["upstream_ms"] = json!(ms(entry.upstream.iter().map(|c| c.elapsed).sum()));
    }
    if !entry.spans.is_empty() {
        value["spans"] = entry
            .spans
            .iter()
            .map(|(name, d)| (name.to_string(), json!(ms(*d))))
            .collect::<serde_json::Map<_, _>>()
            .into();
    }
    value
}

/// Lines go to one writer thread through a bounded queue, so a slow or
/// blocked stderr (a full pipe, a stalled journald) never blocks a request:
/// when the queue is full the line is dropped and counted.
struct Writer {
    queue: std::sync::mpsc::SyncSender<String>,
    dropped: std::sync::atomic::AtomicU64,
}

fn writer() -> &'static Writer {
    static WRITER: std::sync::LazyLock<Writer> = std::sync::LazyLock::new(|| {
        let (queue, lines) = std::sync::mpsc::sync_channel::<String>(4096);
        let _ = std::thread::Builder::new()
            .name("request-log".into())
            .spawn(move || {
                for line in lines {
                    // One write per line keeps concurrent lines whole.
                    let _ = std::io::stderr().lock().write_all(line.as_bytes());
                }
            });
        Writer {
            queue,
            dropped: std::sync::atomic::AtomicU64::new(0),
        }
    });
    &WRITER
}

pub(super) fn request(entry: &RequestLine<'_>) {
    let writer = writer();
    let mut value = line(entry);
    let dropped = writer.dropped.swap(0, std::sync::atomic::Ordering::Relaxed);
    if dropped > 0 {
        value["dropped_before"] = json!(dropped);
    }
    let mut out = value.to_string();
    out.push('\n');
    if writer.queue.try_send(out).is_err() {
        writer
            .dropped
            .fetch_add(1 + dropped, std::sync::atomic::Ordering::Relaxed);
    }
}

/// `Server-Timing`: total, upstream (summed per target) and named spans.
pub(super) fn server_timing(
    elapsed: Duration,
    upstream: &[UpstreamCall],
    spans: &[(&'static str, Duration)],
) -> String {
    let mut parts = vec![format!("app;dur={}", ms(elapsed))];
    let mut targets: Vec<(&str, Duration, usize)> = Vec::new();
    for call in upstream {
        match targets.iter_mut().find(|(t, _, _)| *t == call.target) {
            Some((_, total, count)) => {
                *total += call.elapsed;
                *count += 1;
            }
            None => targets.push((call.target, call.elapsed, 1)),
        }
    }
    for (target, total, count) in targets {
        parts.push(format!(
            "{target};dur={};desc=\"{count} call(s)\"",
            ms(total)
        ));
    }
    for (name, total) in spans {
        parts.push(format!("{name};dur={}", ms(*total)));
    }
    parts.join(", ")
}
