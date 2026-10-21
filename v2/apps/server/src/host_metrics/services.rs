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
fn split_blocks(text: &str) -> Vec<&str> {
    text.split("\n\n")
        .filter(|b| !b.trim().is_empty())
        .collect()
}

fn field(block: &str, key: &str) -> String {
    block
        .lines()
        .find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix('=')))
        .unwrap_or("")
        .to_owned()
}

fn block_of<'a>(blocks: &[&'a str], id: &str) -> &'a str {
    blocks
        .iter()
        .find(|b| b.lines().any(|l| l.strip_prefix("Id=") == Some(id)))
        .copied()
        .unwrap_or("")
}

fn unix_ms(value: &str) -> Option<i64> {
    value
        .strip_prefix('@')
        .and_then(|s| s.parse::<f64>().ok())
        .map(|s| (s * 1000.0) as i64)
        .filter(|t| *t > 0)
}

/// The timer that starts `block`'s unit, if any (validated unit name).
pub(crate) fn trigger(block: &str) -> Option<String> {
    field(block, "TriggeredBy")
        .split_whitespace()
        .find(|t| t.ends_with(".timer") && valid_unit(t))
        .map(str::to_owned)
}

/// `systemctl show` output: one `Key=Value` block per unit, blank-line
/// separated; `timers` holds the blocks of the triggering timers.
pub(crate) fn parse_show(text: &str, timers: &str, units: &[Unit]) -> Vec<ServiceHealth> {
    let blocks = split_blocks(text);
    let timer_blocks = split_blocks(timers);
    units
        .iter()
        .map(|unit| {
            let block = block_of(&blocks, &unit.unit);
            let state = match field(block, "ActiveState").as_str() {
                "active" | "reloading" => ServiceState::Active,
                "activating" | "deactivating" => ServiceState::Activating,
                "inactive" => ServiceState::Inactive,
                "failed" => ServiceState::Failed,
                _ => ServiceState::Unknown,
            };
            let result = field(block, "Result");
            let timer = trigger(block);
            let oneshot = field(block, "Type") == "oneshot" || timer.is_some();
            let timer_active = timer.as_ref().map(|t| {
                matches!(
                    field(block_of(&timer_blocks, t), "ActiveState").as_str(),
                    "active" | "activating" | "reloading"
                )
            });
            let last_run_ms = unix_ms(&field(block, "ExecMainExitTimestamp"));
            let last_exit_status = field(block, "ExecMainStatus").parse::<i32>().ok();
            let healthy = if oneshot {
                // Between runs a timer job is inactive by design: judge the last
                // run (and that its timer still fires), never the idle state.
                let last_ok = result == "success" && last_exit_status.is_none_or(|s| s == 0);
                timer_active != Some(false)
                    && match state {
                        ServiceState::Active | ServiceState::Activating => true,
                        ServiceState::Inactive => last_ok,
                        ServiceState::Failed | ServiceState::Unknown => false,
                    }
            } else {
                state == ServiceState::Active
            };
            ServiceHealth {
                label: unit.label.clone(),
                unit: unit.unit.clone(),
                healthy,
                state,
                sub_state: field(block, "SubState").chars().take(32).collect(),
                result: result.chars().take(32).collect(),
                since_ms: unix_ms(&field(block, "StateChangeTimestamp")),
                restarts: field(block, "NRestarts").parse().unwrap_or(0),
                oneshot,
                last_run_ms: if oneshot { last_run_ms } else { None },
                last_exit_status: if oneshot { last_exit_status } else { None },
                timer_active,
            }
        })
        .collect()
}

fn show(units: &[&str], properties: &str) -> String {
    if units.is_empty() {
        return String::new();
    }
    std::process::Command::new("/usr/bin/systemctl")
        .args(["show", "--timestamp=unix", "-p", properties, "--"])
        .args(units)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

pub(crate) fn read(units: &[Unit]) -> Vec<ServiceHealth> {
    if units.is_empty() {
        return Vec::new();
    }
    let names: Vec<&str> = units.iter().map(|u| u.unit.as_str()).collect();
    let text = show(
        &names,
        "Id,Type,ActiveState,SubState,Result,StateChangeTimestamp,NRestarts,ExecMainStatus,ExecMainExitTimestamp,TriggeredBy",
    );
    let timers: Vec<String> = split_blocks(&text)
        .into_iter()
        .filter_map(trigger)
        .collect();
    let timer_names: Vec<&str> = timers.iter().map(String::as_str).collect();
    let timer_text = show(&timer_names, "Id,ActiveState,SubState");
    parse_show(&text, &timer_text, units)
}
