//! Operator-listed systemd units, read with `systemctl show` (no privileges
//! needed). The list comes from `<ORKESTR_V2_HOME>/health-units.json`:
//! `[{"label": "Adapter", "unit": "orkestr-v2-wa-adapter.service"}, …]`.
use orkestr_v2_contracts::{ServiceHealth, ServiceState};
use std::path::Path;

pub(crate) const UNITS_FILE: &str = "health-units.json";
const MAX_UNITS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Unit {
    pub label: String,
    pub unit: String,
}

fn valid_unit(unit: &str) -> bool {
    let name = unit
        .strip_suffix(".service")
        .or_else(|| unit.strip_suffix(".timer"));
    name.is_some_and(|n| {
        !n.is_empty()
            && n.len() <= 120
            && !n.starts_with('-')
            && n.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"@._:-".contains(&b))
    })
}

/// A missing file means no listed units; an invalid one is ignored as a whole.
pub(crate) fn load(home: &Path) -> Vec<Unit> {
    let Ok(raw) = std::fs::read(home.join(UNITS_FILE)) else {
        return Vec::new();
    };
    parse(&raw).unwrap_or_default()
}

pub(crate) fn parse(raw: &[u8]) -> Option<Vec<Unit>> {
    let units: Vec<Unit> = serde_json::from_slice(raw).ok()?;
    (units.len() <= MAX_UNITS
        && units.iter().all(|u| {
            valid_unit(&u.unit)
                && (1..=40).contains(&u.label.chars().count())
                && !u.label.chars().any(char::is_control)
        }))
    .then_some(units)
}

/// `systemctl show` output: one `Key=Value` block per unit, blank-line separated.
pub(crate) fn parse_show(text: &str, units: &[Unit]) -> Vec<ServiceHealth> {
    let blocks: Vec<&str> = text
        .split("\n\n")
        .filter(|b| !b.trim().is_empty())
        .collect();
    units
        .iter()
        .map(|unit| {
            let block = blocks
                .iter()
                .find(|b| b.lines().any(|l| l == format!("Id={}", unit.unit)))
                .copied()
                .unwrap_or("");
            let field = |key: &str| {
                block
                    .lines()
                    .find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix('=')))
                    .unwrap_or("")
                    .to_owned()
            };
            let active = field("ActiveState");
            let state = match active.as_str() {
                "active" | "reloading" => ServiceState::Active,
                "activating" | "deactivating" => ServiceState::Activating,
                "inactive" => ServiceState::Inactive,
                "failed" => ServiceState::Failed,
                _ => ServiceState::Unknown,
            };
            let result = field("Result");
            let since_ms = field("StateChangeTimestamp")
                .strip_prefix('@')
                .and_then(|s| s.parse::<f64>().ok())
                .map(|s| (s * 1000.0) as i64)
                .filter(|t| *t > 0);
            ServiceHealth {
                label: unit.label.clone(),
                unit: unit.unit.clone(),
                healthy: match state {
                    ServiceState::Active => true,
                    // A timer job (probe) between runs: healthy if its last run succeeded.
                    ServiceState::Inactive => result == "success" && field("Type") == "oneshot",
                    _ => false,
                },
                state,
                sub_state: field("SubState").chars().take(32).collect(),
                result: result.chars().take(32).collect(),
                since_ms,
                restarts: field("NRestarts").parse().unwrap_or(0),
            }
        })
        .collect()
}

pub(crate) fn read(units: &[Unit]) -> Vec<ServiceHealth> {
    if units.is_empty() {
        return Vec::new();
    }
    let output = std::process::Command::new("/usr/bin/systemctl")
        .args([
            "show",
            "--timestamp=unix",
            "-p",
            "Id,Type,ActiveState,SubState,Result,StateChangeTimestamp,NRestarts",
            "--",
        ])
        .args(units.iter().map(|u| u.unit.as_str()))
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output();
    let text = output
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    parse_show(&text, units)
}
