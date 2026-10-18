use super::*;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub(super) fn scope_text(scope: &Scope) -> String {
    match scope {
        Scope::Global => "global".into(),
        Scope::Project { project_id } => format!("project:{project_id}"),
    }
}
pub(super) fn parse_scope(text: &str) -> Result<Scope> {
    if text == "global" {
        return Ok(Scope::Global);
    }
    let id = text
        .strip_prefix("project:")
        .ok_or(HistoryError::Conflict)?;
    let uuid = Uuid::parse_str(id).map_err(|_| HistoryError::Conflict)?;
    if uuid.is_nil() || uuid.to_string() != id {
        return Err(HistoryError::Conflict);
    }
    Ok(Scope::Project {
        project_id: ProjectId(uuid),
    })
}
pub(super) fn canonical(request: &HistoryImportRequest) -> Result<Vec<u8>> {
    if request.namespace.is_nil()
        || request.source_conversation_id.0.is_nil()
        || request.source_watermark < 0
        || request.messages.len() > 100_000
    {
        return Err(HistoryError::Invalid);
    }
    let mut bytes = b"orkestr-history-v1\0".to_vec();
    bytes.extend(request.source_conversation_id.0.as_bytes());
    match &request.source_scope {
        Scope::Global => bytes.push(0),
        Scope::Project { project_id } => {
            if project_id.0.is_nil() {
                return Err(HistoryError::Invalid);
            }
            bytes.push(1);
            bytes.extend(project_id.0.as_bytes());
        }
    }
    bytes.extend((request.source_watermark as u64).to_be_bytes());
    bytes.extend((request.messages.len() as u64).to_be_bytes());
    let mut last = 0;
    let mut ids = HashSet::new();
    for message in &request.messages {
        if message.message_id.0.is_nil()
            || !ids.insert(&message.message_id)
            || message.sequence <= last
            || message.sequence > request.source_watermark
            || message.actor_kind != "owner"
            || message.text.len() > 1024 * 1024
        {
            return Err(HistoryError::Invalid);
        }
        last = message.sequence;
        bytes.extend(message.message_id.0.as_bytes());
        bytes.extend((message.sequence as u64).to_be_bytes());
        for text in [&message.actor_kind, &message.text] {
            bytes.extend((text.len() as u64).to_be_bytes());
            bytes.extend(text.as_bytes());
        }
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(HistoryError::Invalid);
        }
    }
    Ok(bytes)
}
/// Exact binary source-content digest; the supplied digest is deliberately excluded.
pub fn history_source_digest(request: &HistoryImportRequest) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(canonical(request)?)))
}
