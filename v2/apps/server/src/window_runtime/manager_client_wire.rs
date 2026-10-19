//! Bounded wire helpers, canonical serialization and local process observations.
use super::{Result, INTEGER_LIMIT};
use serde_json::Value;
use std::io::Read;
use tokio::net::UnixStream;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagerError {
    InvalidRequest,
    Peer,
    Deadline,
    Unavailable,
    Protocol,
    Refused,
}
impl std::fmt::Display for ManagerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "manager control {:?}", self)
    }
}
impl std::error::Error for ManagerError {}
pub(super) fn key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
pub(super) fn dates(open: i64, work: i64, end: i64) -> bool {
    [open, work, end]
        .iter()
        .all(|n| *n >= 0 && (*n as u64) < INTEGER_LIMIT)
        && end.checked_sub(open) == Some(900_000)
        && end.checked_sub(work) == Some(30_000)
}
pub(super) fn id(v: &Value) -> Result<Uuid> {
    let text = v.as_str().ok_or(ManagerError::Protocol)?;
    let id = Uuid::parse_str(text).map_err(|_| ManagerError::Protocol)?;
    if id.is_nil() || id.to_string() != text {
        return Err(ManagerError::Protocol);
    }
    Ok(id)
}
pub(super) fn fields(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
pub(super) fn boolean(v: &Value, key: &str) -> Result<bool> {
    v[key].as_bool().ok_or(ManagerError::Protocol)
}
pub(super) fn success_fields(v: &Value, extra: Option<&str>) -> Result<()> {
    let mut keys = vec!["ok", "receipt"];
    if let Some(extra) = extra {
        keys.push(extra);
    }
    if !fields(v, &keys) || v["ok"] != true {
        return Err(ManagerError::Protocol);
    }
    Ok(())
}
pub(super) fn canonical(mut value: Value) -> Result<Vec<u8>> {
    value.sort_all_objects();
    serde_json::to_vec(&value).map_err(|_| ManagerError::Protocol)
}
pub(super) fn process(pid: u32) -> Result<(u32, u64)> {
    let mut bytes = Vec::new();
    std::fs::File::open(format!("/proc/{pid}/stat"))
        .map_err(|_| ManagerError::Peer)?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| ManagerError::Peer)?;
    if bytes.len() > 4096 {
        return Err(ManagerError::Peer);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| ManagerError::Peer)?;
    let (_, suffix) = text.rsplit_once(')').ok_or(ManagerError::Peer)?;
    let fields: Vec<_> = suffix.split_whitespace().collect();
    let parent = fields
        .get(1)
        .and_then(|s| s.parse().ok())
        .ok_or(ManagerError::Peer)?;
    let start = fields
        .get(19)
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
        .ok_or(ManagerError::Peer)?;
    Ok((parent, start))
}
pub(super) async fn read(stream: &UnixStream, count: usize) -> Result<Vec<u8>> {
    let mut bytes = vec![0; count];
    let mut used = 0;
    while used < count {
        stream
            .readable()
            .await
            .map_err(|_| ManagerError::Unavailable)?;
        match stream.try_read(&mut bytes[used..]) {
            Ok(0) => return Err(ManagerError::Protocol),
            Ok(n) => used += n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => return Err(ManagerError::Unavailable),
        }
    }
    Ok(bytes)
}
pub(super) async fn write(stream: &UnixStream, mut bytes: &[u8]) -> Result<()> {
    while !bytes.is_empty() {
        stream
            .writable()
            .await
            .map_err(|_| ManagerError::Unavailable)?;
        match stream.try_write(bytes) {
            Ok(0) => return Err(ManagerError::Unavailable),
            Ok(n) => bytes = &bytes[n..],
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => return Err(ManagerError::Unavailable),
        }
    }
    Ok(())
}
