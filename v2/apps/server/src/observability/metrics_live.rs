//! Browser live channel counters (see `docs/v2/live-channel.md`): open
//! channels per transport, opens and reconnects, frames pushed per type,
//! paths reported changed, server-side fingerprint reads, closes per reason,
//! and the fallback polls and reconnects browsers report while degraded.
//! Counts only: no paths, owners or conversation ids.
use serde_json::{json, Value};
use std::{
    fmt::Write,
    sync::atomic::{AtomicI64, AtomicU64, Ordering},
};

/// Transports of the live channel.
pub const TRANSPORTS: [&str; 2] = ["websocket", "sse"];
/// Frame types the server pushes.
pub const FRAMES: [&str; 7] = [
    "hello", "hb", "changed", "watching", "refused", "expired", "bye",
];
/// Why a channel ended.
pub const CLOSES: [&str; 8] = [
    "client",
    "write_error",
    "idle",
    "lifetime",
    "expired",
    "replaced",
    "shutdown",
    "protocol",
];

fn index(names: &[&str], name: &str) -> usize {
    names
        .iter()
        .position(|n| *n == name)
        .unwrap_or(names.len() - 1)
}

#[derive(Default)]
pub struct LiveMetrics {
    open: [AtomicI64; 2],
    opened: [AtomicU64; 2],
    reconnects: AtomicU64,
    frames: [AtomicU64; 7],
    invalidations: AtomicU64,
    reads: AtomicU64,
    read_micros: AtomicU64,
    closed: [AtomicU64; 8],
    fallback_polls: AtomicU64,
    client_reconnects: AtomicU64,
}

impl LiveMetrics {
    /// One channel opened; `resumed` when the browser says it reconnects.
    pub fn opened(&self, transport: &str, resumed: bool) {
        let at = index(&TRANSPORTS, transport);
        self.open[at].fetch_add(1, Ordering::Relaxed);
        self.opened[at].fetch_add(1, Ordering::Relaxed);
        if resumed {
            self.reconnects.fetch_add(1, Ordering::Relaxed);
        }
    }
    pub fn closed(&self, transport: &str, reason: &str) {
        self.open[index(&TRANSPORTS, transport)].fetch_sub(1, Ordering::Relaxed);
        self.closed[index(&CLOSES, reason)].fetch_add(1, Ordering::Relaxed);
    }
    pub fn frame(&self, kind: &str) {
        self.frames[index(&FRAMES, kind)].fetch_add(1, Ordering::Relaxed);
    }
    pub fn invalidated(&self, paths: usize) {
        self.invalidations
            .fetch_add(paths as u64, Ordering::Relaxed);
    }
    pub fn read(&self, elapsed: std::time::Duration) {
        self.reads.fetch_add(1, Ordering::Relaxed);
        self.read_micros.fetch_add(
            u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX),
            Ordering::Relaxed,
        );
    }
    /// What a browser reports: fallback polls it made while its channel was
    /// down and reconnect attempts it started. Bounded per report.
    pub fn reported(&self, fallback_polls: u64, reconnects: u64) {
        self.fallback_polls
            .fetch_add(fallback_polls.min(10_000), Ordering::Relaxed);
        self.client_reconnects
            .fetch_add(reconnects.min(10_000), Ordering::Relaxed);
    }
    pub fn open_channels(&self) -> i64 {
        self.open
            .iter()
            .map(|v| v.load(Ordering::Relaxed))
            .sum::<i64>()
            .max(0)
    }

    pub fn summary(&self) -> Value {
        let load = |v: &AtomicU64| v.load(Ordering::Relaxed);
        let per = |names: &[&str], values: &[AtomicU64]| -> Value {
            names
                .iter()
                .zip(values)
                .map(|(n, v)| ((*n).to_owned(), json!(load(v))))
                .collect::<serde_json::Map<_, _>>()
                .into()
        };
        json!({
            "open": TRANSPORTS.iter().zip(&self.open)
                .map(|(n, v)| ((*n).to_owned(), json!(v.load(Ordering::Relaxed).max(0))))
                .collect::<serde_json::Map<_, _>>(),
            "opened_total": per(&TRANSPORTS, &self.opened),
            "reconnects_total": load(&self.reconnects),
            "frames_total": per(&FRAMES, &self.frames),
            "invalidations_total": load(&self.invalidations),
            "reads_total": load(&self.reads),
            "read_seconds_total": load(&self.read_micros) as f64 / 1e6,
            "closed_total": per(&CLOSES, &self.closed),
            "fallback_polls_total": load(&self.fallback_polls),
            "client_reconnects_total": load(&self.client_reconnects),
        })
    }

    pub fn prometheus(&self, out: &mut String) {
        let load = |v: &AtomicU64| v.load(Ordering::Relaxed);
        let _ = writeln!(out, "# HELP orkestr_v2_live_channels Open browser live channels.\n# TYPE orkestr_v2_live_channels gauge");
        for (name, value) in TRANSPORTS.iter().zip(&self.open) {
            let _ = writeln!(
                out,
                "orkestr_v2_live_channels{{transport=\"{name}\"}} {}",
                value.load(Ordering::Relaxed).max(0)
            );
        }
        let _ = writeln!(out, "# HELP orkestr_v2_live_channels_opened_total Live channels opened.\n# TYPE orkestr_v2_live_channels_opened_total counter");
        for (name, value) in TRANSPORTS.iter().zip(&self.opened) {
            let _ = writeln!(
                out,
                "orkestr_v2_live_channels_opened_total{{transport=\"{name}\"}} {}",
                load(value)
            );
        }
        let _ = writeln!(out, "# HELP orkestr_v2_live_reconnects_total Live channels opened by a reconnecting browser.\n# TYPE orkestr_v2_live_reconnects_total counter\norkestr_v2_live_reconnects_total {}", load(&self.reconnects));
        let _ = writeln!(out, "# HELP orkestr_v2_live_frames_total Live channel frames pushed by type.\n# TYPE orkestr_v2_live_frames_total counter");
        for (name, value) in FRAMES.iter().zip(&self.frames) {
            let _ = writeln!(
                out,
                "orkestr_v2_live_frames_total{{type=\"{name}\"}} {}",
                load(value)
            );
        }
        let _ = writeln!(out, "# HELP orkestr_v2_live_invalidations_total Watched paths reported changed.\n# TYPE orkestr_v2_live_invalidations_total counter\norkestr_v2_live_invalidations_total {}", load(&self.invalidations));
        let _ = writeln!(out, "# HELP orkestr_v2_live_reads_total Server-side fingerprint reads of watched paths.\n# TYPE orkestr_v2_live_reads_total counter\norkestr_v2_live_reads_total {}", load(&self.reads));
        let _ = writeln!(out, "# HELP orkestr_v2_live_read_seconds_total Time spent in fingerprint reads.\n# TYPE orkestr_v2_live_read_seconds_total counter\norkestr_v2_live_read_seconds_total {}", load(&self.read_micros) as f64 / 1e6);
        let _ = writeln!(out, "# HELP orkestr_v2_live_closed_total Live channels closed by reason.\n# TYPE orkestr_v2_live_closed_total counter");
        for (name, value) in CLOSES.iter().zip(&self.closed) {
            let _ = writeln!(
                out,
                "orkestr_v2_live_closed_total{{reason=\"{name}\"}} {}",
                load(value)
            );
        }
        let _ = writeln!(out, "# HELP orkestr_v2_live_fallback_polls_total Fallback polls browsers reported while their channel was down.\n# TYPE orkestr_v2_live_fallback_polls_total counter\norkestr_v2_live_fallback_polls_total {}", load(&self.fallback_polls));
        let _ = writeln!(out, "# HELP orkestr_v2_live_client_reconnects_total Reconnect attempts browsers reported.\n# TYPE orkestr_v2_live_client_reconnects_total counter\norkestr_v2_live_client_reconnects_total {}", load(&self.client_reconnects));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_add_up_and_render() {
        let live = LiveMetrics::default();
        live.opened("websocket", false);
        live.opened("sse", true);
        live.frame("hb");
        live.frame("changed");
        live.invalidated(3);
        live.reported(2, 1);
        live.closed("sse", "write_error");
        assert_eq!(live.open_channels(), 1);
        let summary = live.summary();
        assert_eq!(summary["open"]["websocket"], 1);
        assert_eq!(summary["open"]["sse"], 0);
        assert_eq!(summary["reconnects_total"], 1);
        assert_eq!(summary["frames_total"]["changed"], 1);
        assert_eq!(summary["invalidations_total"], 3);
        assert_eq!(summary["fallback_polls_total"], 2);
        assert_eq!(summary["closed_total"]["write_error"], 1);
        let mut text = String::new();
        live.prometheus(&mut text);
        assert!(text.contains("orkestr_v2_live_channels{transport=\"websocket\"} 1"));
        assert!(text.contains("orkestr_v2_live_fallback_polls_total 2"));
        assert!(text.contains("orkestr_v2_live_frames_total{type=\"hb\"} 1"));
        // Unknown names land in the last bucket instead of panicking.
        live.frame("unknown");
        live.closed("websocket", "unknown");
    }
}
