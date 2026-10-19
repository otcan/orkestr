//! Linux-only bounded read; no legacy connector helpers, initialization or writes.
use super::strict_json;
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};
pub(super) const MAX_BYTES: u64 = 1024 * 1024;
const CAPS: [&str; 6] = [
    "gmail_read",
    "gmail_send",
    "gmail_actions",
    "gmail_drafts",
    "calendar_read",
    "calendar_actions",
];

#[cfg(target_os = "linux")]
fn read(path: &Path) -> Result<Vec<u8>, ()> {
    use std::{
        fs::OpenOptions,
        io::Read,
        os::{
            fd::AsRawFd,
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
        path::Component,
    };
    // Linux UAPI flags; no additional dependency or fallback that follows links.
    const NOFOLLOW: i32 = 0x20000;
    const DIRECTORY: i32 = 0x10000;
    const NONBLOCK: i32 = 0x800;
    if !path.is_absolute()
        || path.file_name().and_then(|v| v.to_str()) != Some("google-workspace-connections.json")
    {
        return Err(());
    }
    let parts: Vec<_> = path.components().collect();
    if parts
        .iter()
        .skip(1)
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(());
    }
    let open = |path: &Path, flags| {
        OpenOptions::new()
            .read(true)
            .custom_flags(flags)
            .open(path)
            .map_err(|_| ())
    };
    let mut directory = open(Path::new("/"), DIRECTORY | NOFOLLOW)?;
    for part in &parts[1..parts.len() - 1] {
        let child = std::path::PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()))
            .join(part.as_os_str());
        directory = open(&child, DIRECTORY | NOFOLLOW)?;
    }
    let final_path = std::path::PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()))
        .join(path.file_name().ok_or(())?);
    let file = open(&final_path, NOFOLLOW | NONBLOCK)?;
    let before = file.metadata().map_err(|_| ())?;
    if !before.is_file() || before.nlink() != 1 || before.len() > MAX_BYTES {
        return Err(());
    }
    let mut bytes = Vec::new();
    let mut bounded = file.take(MAX_BYTES + 1);
    bounded.read_to_end(&mut bytes).map_err(|_| ())?;
    let after = bounded.get_ref().metadata().map_err(|_| ())?;
    let identity = |m: &std::fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    if bytes.len() as u64 > MAX_BYTES || identity(&before) != identity(&after) {
        return Err(());
    }
    Ok(bytes)
}
#[cfg(not(target_os = "linux"))]
fn read(_: &Path) -> Result<Vec<u8>, ()> {
    Err(())
}

pub(super) fn metadata(path: &Path, legacy_owner: &str) -> Result<Value, ()> {
    project(strict_json::parse(&read(path)?)?, legacy_owner)
}
fn project(raw: Value, owner: &str) -> Result<Value, ()> {
    if raw.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || raw.get("ownerUserId").and_then(Value::as_str) != Some(owner)
    {
        return Err(());
    }
    let rows = raw.get("connections").and_then(Value::as_array).ok_or(())?;
    if rows.len() > 1024 {
        return Err(());
    }
    let mut cap_counts = serde_json::Map::new();
    for cap in CAPS {
        cap_counts.insert(cap.into(), json!(0));
    }
    let mut result = json!({"format_version":1,"connections":rows.len(),"capabilities":cap_counts,
        "unknown_capability_connections":0,"health":{"connected":0,"disconnected":0,"error":0,"unknown":0},
        "use_mode":{"default":0,"available":0,"explicit_only":0,"unknown":0},
        "configuration_only":true,"activity_proven":false,"provider_readiness_verified":false});
    let mut seen = HashSet::new();
    for row in rows {
        if row.get("ownerUserId").and_then(Value::as_str) != Some(owner) {
            return Err(());
        }
        let id = row
            .get("connectionId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| row.get("accountId").and_then(Value::as_str))
            .ok_or(())?
            .trim();
        if id.is_empty() || !seen.insert(id.to_owned()) {
            return Err(());
        }
        let caps = match row.get("capabilities") {
            None => Vec::new(),
            Some(Value::Array(values)) if values.len() <= 128 => values
                .iter()
                .map(|v| v.as_str().map(str::trim).ok_or(()))
                .collect::<Result<Vec<_>, _>>()?,
            _ => return Err(()),
        };
        let caps: HashSet<_> = caps.into_iter().collect();
        for cap in CAPS {
            if caps.contains(cap) {
                increment(&mut result["capabilities"][cap]);
            }
        }
        if caps.iter().any(|cap| !CAPS.contains(cap)) {
            increment(&mut result["unknown_capability_connections"]);
        }
        for (field, output, allowed) in [
            (
                "healthState",
                "health",
                ["connected", "disconnected", "error"],
            ),
            (
                "useMode",
                "use_mode",
                ["default", "available", "explicit_only"],
            ),
        ] {
            let value = row
                .get(field)
                .and_then(Value::as_str)
                .filter(|v| allowed.contains(v))
                .unwrap_or("unknown");
            increment(&mut result[output][value]);
        }
    }
    Ok(result)
}
fn increment(value: &mut Value) {
    *value = json!(value.as_u64().unwrap_or(0) + 1);
}
