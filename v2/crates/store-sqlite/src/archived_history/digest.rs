//! Pinned binary content digest shared with the Python producer.
//!
//! Bytes: ASCII `orkestr-archived-message-v1` + NUL; then source message ID
//! (string), source position (i64 BE), role (string), phase (optional),
//! created_at (optional), text (string), attachment count (u64 BE) and per
//! attachment name (string), sha256 (string), bytes (u64 BE), media type
//! (optional), available (one byte). A string is its UTF-8 byte length as
//! u64 BE followed by the exact bytes; an optional is byte 0 when absent or
//! byte 1 followed by the string. Volatile delivery state, update timestamps
//! and cursors are stored but deliberately excluded from identity.
use orkestr_v2_contracts::ArchivedMessage;
use sha2::{Digest, Sha256};

fn string(bytes: &mut Vec<u8>, value: &str) {
    bytes.extend((value.len() as u64).to_be_bytes());
    bytes.extend(value.as_bytes());
}
fn optional(bytes: &mut Vec<u8>, value: &Option<String>) {
    match value {
        None => bytes.push(0),
        Some(value) => {
            bytes.push(1);
            string(bytes, value);
        }
    }
}

pub fn archived_message_canonical(message: &ArchivedMessage) -> Vec<u8> {
    let mut bytes = b"orkestr-archived-message-v1\0".to_vec();
    string(&mut bytes, &message.source_message_id);
    bytes.extend(message.source_position.to_be_bytes());
    string(&mut bytes, &message.role);
    optional(&mut bytes, &message.phase);
    optional(&mut bytes, &message.created_at);
    string(&mut bytes, &message.text);
    bytes.extend((message.attachments.len() as u64).to_be_bytes());
    for attachment in &message.attachments {
        string(&mut bytes, &attachment.name);
        string(&mut bytes, &attachment.sha256);
        bytes.extend(attachment.bytes.to_be_bytes());
        optional(&mut bytes, &attachment.media_type);
        bytes.push(u8::from(attachment.available));
    }
    bytes
}

/// Lowercase SHA-256 of the canonical bytes above.
pub fn archived_message_digest(message: &ArchivedMessage) -> String {
    format!("{:x}", Sha256::digest(archived_message_canonical(message)))
}

/// Ordered chain: `sha256(previous_hex + ":" + digest_hex)`, starting from "".
pub fn archived_checksum_next(previous: &str, digest: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{previous}:{digest}").as_bytes())
    )
}
