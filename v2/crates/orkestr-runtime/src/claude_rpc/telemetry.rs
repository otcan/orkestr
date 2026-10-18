//! Closed broker-sanitized housekeeping; never readiness or result evidence.
use super::*;

pub(super) fn accept(value: &Value, seen: &mut HashSet<String>) -> Result<(), Blocker> {
    let fields = value.as_object().ok_or(Blocker::Protocol)?;
    if fields.len() != 3
        || fields
            .keys()
            .any(|key| !matches!(key.as_str(), "type" | "session_id" | "uuid"))
    {
        return Err(Blocker::Protocol);
    }
    let id = text(value, "uuid")?;
    if !uuid(id) || seen.len() >= 128 || !seen.insert(id.to_ascii_lowercase()) {
        return Err(Blocker::Protocol);
    }
    Ok(())
}
