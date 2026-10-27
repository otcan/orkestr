//! Admission gates of read-only parallel Deep slots beyond host pressure
//! (docs/v2/parallel-deep.md): the Codex account's five-hour quota and the
//! window's egress budget. Every gate fails closed: an unreadable, stale or
//! unconfigured reading starts no new slot. Slots already live finish.
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Operator-configured projection file, passed by the service manager from
/// the package's `codex_quota_projection` (`<directory>/codex.json`).
pub const QUOTA_FILE_ENV: &str = "ORKESTR_V2_CODEX_QUOTA_FILE";
/// No new slot at or above this share of the five-hour window.
pub(super) const QUOTA_USED_LIMIT: f64 = 80.0;
/// A reading older than this is stale (the projection updates on every
/// provider turn, and slots only start while the writer runs one).
pub(super) const QUOTA_FRESH: Duration = Duration::from_secs(30 * 60);
/// No new slot once less than this share of the window's egress remains.
pub(super) const EGRESS_LEFT_MIN: f64 = 0.25;
const MAX_QUOTA_BYTES: u64 = 16 * 1024;
const QUOTA_READ: Duration = Duration::from_secs(10);

static QUOTA_FILE: OnceLock<PathBuf> = OnceLock::new();
static QUOTA_CACHE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);

/// Trusted startup only (absolute path); later calls are ignored.
pub fn set_quota_file(path: PathBuf) {
    if path.is_absolute() {
        let _ = QUOTA_FILE.set(path);
    }
}

/// Whether the five-hour quota admits one more slot now (cached 10 s).
pub(super) fn quota_allows() -> bool {
    if let Ok(cached) = QUOTA_CACHE.lock() {
        if let Some((at, allows)) = *cached {
            if at.elapsed() < QUOTA_READ {
                return allows;
            }
        }
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| i64::try_from(since.as_millis()).unwrap_or(0));
    let allows = QUOTA_FILE
        .get()
        .is_some_and(|path| read(path).is_some_and(|value| five_hour_allows(&value, now_ms)));
    if let Ok(mut cached) = QUOTA_CACHE.lock() {
        *cached = Some((Instant::now(), allows));
    }
    allows
}

fn read(path: &Path) -> Option<serde_json::Value> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut raw = Vec::new();
    file.take(MAX_QUOTA_BYTES + 1).read_to_end(&mut raw).ok()?;
    if raw.len() as u64 > MAX_QUOTA_BYTES {
        return None;
    }
    serde_json::from_slice(&raw).ok()
}

/// The closed `orkestr-provider-quota-v1` Codex projection: the five-hour
/// window must be present and either reset since it was observed, or fresh
/// and below the limit. Anything else (absent window, stale, malformed)
/// fails closed.
pub(super) fn five_hour_allows(value: &serde_json::Value, now_ms: i64) -> bool {
    if value.get("format").and_then(|v| v.as_str()) != Some("orkestr-provider-quota-v1")
        || value.get("provider").and_then(|v| v.as_str()) != Some("codex")
    {
        return false;
    }
    let Some(window) = value.pointer("/windows/five_hour") else {
        return false;
    };
    let (Some(used), Some(observed)) = (
        window
            .get("used_percent")
            .and_then(serde_json::Value::as_f64),
        window
            .get("observed_at")
            .and_then(serde_json::Value::as_i64),
    ) else {
        return false;
    };
    if !(0.0..=100.0).contains(&used) || observed <= 0 || observed > now_ms + 60_000 {
        return false;
    }
    // The window reset after this reading: its usage started again from zero.
    if window
        .get("resets_at")
        .and_then(serde_json::Value::as_i64)
        .is_some_and(|reset| reset > 0 && reset.saturating_mul(1000) <= now_ms)
    {
        return true;
    }
    let fresh =
        now_ms.saturating_sub(observed) <= i64::try_from(QUOTA_FRESH.as_millis()).unwrap_or(0);
    fresh && used < QUOTA_USED_LIMIT
}

/// Whether the window's remaining egress share admits one more slot.
pub(super) fn egress_allows(left: Option<f64>) -> bool {
    left.is_some_and(|left| left.is_finite() && left >= EGRESS_LEFT_MIN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_793_200_000_000;

    fn quota(window: serde_json::Value) -> serde_json::Value {
        json!({"format":"orkestr-provider-quota-v1","provider":"codex",
               "owner_id":"6a0a04ea-407d-4fc8-bdfd-dd3d2b123e85","account_ref":"c14f99e8-795a-4f2b-be45-6331bb74fd83",
               "windows": window})
    }

    #[test]
    fn the_five_hour_window_gates_below_eighty_percent_and_fails_closed() {
        let fresh = NOW - 60_000;
        let later = NOW / 1000 + 3600;
        let at = |used: f64| {
            quota(
                json!({"five_hour":{"used_percent":used,"resets_at":later,"status":null,"observed_at":fresh}}),
            )
        };
        assert!(five_hour_allows(&at(10.0), NOW));
        assert!(five_hour_allows(&at(79.9), NOW));
        assert!(!five_hour_allows(&at(80.0), NOW));
        assert!(!five_hour_allows(&at(100.0), NOW));
        // Stale reading: closed.
        let stale = quota(
            json!({"five_hour":{"used_percent":5,"resets_at":later,"status":null,
            "observed_at": NOW - 31 * 60_000}}),
        );
        assert!(!five_hour_allows(&stale, NOW));
        // Reset since the (old) reading: usage restarted from zero.
        let reset = quota(
            json!({"five_hour":{"used_percent":95,"resets_at": NOW / 1000 - 10,"status":null,
            "observed_at": NOW - 3 * 3_600_000}}),
        );
        assert!(five_hour_allows(&reset, NOW));
        // Only a weekly window (the live projection may be sparse): closed.
        let weekly = quota(
            json!({"seven_day":{"used_percent":10,"resets_at":later,"status":null,"observed_at":fresh}}),
        );
        assert!(!five_hour_allows(&weekly, NOW));
        // Malformed or foreign: closed.
        assert!(!five_hour_allows(&json!({}), NOW));
        let mut claude = at(10.0);
        claude["provider"] = json!("claude");
        assert!(!five_hour_allows(&claude, NOW));
        let future = quota(
            json!({"five_hour":{"used_percent":5,"resets_at":later,"status":null,
            "observed_at": NOW + 3_600_000}}),
        );
        assert!(!five_hour_allows(&future, NOW));
    }

    #[test]
    fn the_egress_gate_needs_a_quarter_of_the_budget_and_fails_closed() {
        assert!(egress_allows(Some(1.0)));
        assert!(egress_allows(Some(0.25)));
        assert!(!egress_allows(Some(0.24)));
        assert!(!egress_allows(None));
        assert!(!egress_allows(Some(f64::NAN)));
    }

    #[test]
    fn an_unreadable_file_fails_closed() {
        assert!(read(Path::new("/nonexistent/orkestr-quota/codex.json")).is_none());
    }
}
