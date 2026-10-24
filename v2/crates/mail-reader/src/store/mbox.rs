//! Incremental mbox traversal and compaction detection.
use super::*;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Digest of the file's first `len` bytes.
fn head_digest(file: &mut File, len: u64) -> io::Result<String> {
    let mut head = Vec::new();
    file.seek(SeekFrom::Start(0))?;
    file.take(len).read_to_end(&mut head)?;
    if (head.len() as u64) < len {
        return Ok(String::new());
    }
    Ok(Sha256::digest(&head)[..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

pub(super) fn scan_mbox(
    path: &Path,
    previous: Option<&FolderCursor>,
    limits: &ScanLimits,
    now: SystemTime,
    out: &mut ScanOutput,
) -> io::Result<Option<FolderCursor>> {
    if limits.max_mbox_bytes < 16 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "mbox chunk limit must be at least 16 bytes",
        ));
    }
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            out.stats.missing_folders += 1;
            return Ok(previous.cloned());
        }
        Err(e) => return Err(e),
    };
    let meta = file.metadata()?;
    out.stats.files_seen += 1;
    if !meta.is_file() {
        out.stats.missing_folders += 1;
        return Ok(previous.cloned());
    }
    // Same head as last time (over the length hashed then) and not shorter:
    // an append. Anything else is a rewrite (compaction): start over.
    let mut offset = match previous {
        Some(FolderCursor::Mbox {
            offset,
            head,
            head_len,
        }) if *offset <= meta.len() && head_digest(&mut file, *head_len)? == *head => *offset,
        _ => 0,
    };
    let head_len = meta.len().min(4096);
    let head = head_digest(&mut file, head_len)?;
    if offset == meta.len() {
        return Ok(Some(FolderCursor::Mbox {
            offset,
            head,
            head_len,
        }));
    }
    if !settled(&meta, limits, now) {
        out.stats.skipped_unsettled += 1;
        return Ok(previous.cloned());
    }
    let at_line_start = if offset == 0 {
        true
    } else {
        file.seek(SeekFrom::Start(offset - 1))?;
        let mut previous_byte = [0];
        file.read_exact(&mut previous_byte)?;
        previous_byte[0] == b'\n'
    };
    file.seek(SeekFrom::Start(offset))?;
    let mut chunk = Vec::new();
    (&mut file)
        .take(limits.max_mbox_bytes)
        .read_to_end(&mut chunk)?;
    let base = offset;
    let complete = base + chunk.len() as u64 == meta.len();
    let starts = message_starts(&chunk, at_line_start);
    for (index, &start) in starts.iter().enumerate() {
        let end = match starts.get(index + 1) {
            Some(&next) => next,
            None if complete => chunk.len(),
            // The last message may continue past this chunk: next scan.
            None => {
                if index == 0 && chunk.len() as u64 >= limits.max_mbox_bytes {
                    // One message larger than a whole scan chunk: skip past it.
                    out.stats.skipped_large += 1;
                    // Retain enough overlap to find a separator split across chunks.
                    offset = base + chunk.len().saturating_sub(5) as u64;
                }
                out.stats.truncated = true;
                break;
            }
        };
        if out.stats.examined() >= limits.max_messages {
            out.stats.truncated = true;
            break;
        }
        let message = &chunk[start..end];
        // Drop the `From ` separator line itself.
        let body_start = message
            .iter()
            .position(|&b| b == b'\n')
            .map_or(message.len(), |p| p + 1);
        if (message.len() as u64) > limits.max_message_bytes {
            out.stats.skipped_large += 1;
        } else {
            keep(envelope::parse(&message[body_start..]), limits, out);
        }
        offset = base + end as u64;
    }
    if starts.is_empty() {
        if complete {
            offset = meta.len();
        } else {
            // We are inside a previously skipped oversized message. Keep moving
            // until its next separator instead of returning an unchanged cursor.
            offset = base + chunk.len().saturating_sub(5) as u64;
            out.stats.truncated = true;
        }
    }
    Ok(Some(FolderCursor::Mbox {
        offset,
        head,
        head_len,
    }))
}

/// Byte offsets of `From ` separator lines (at the start, or after a newline).
fn message_starts(chunk: &[u8], at_line_start: bool) -> Vec<usize> {
    let mut starts = Vec::new();
    if at_line_start && chunk.starts_with(b"From ") {
        starts.push(0);
    }
    let mut i = 0;
    while let Some(p) = chunk[i..].iter().position(|&b| b == b'\n') {
        let at = i + p + 1;
        if chunk[at..].starts_with(b"From ") {
            starts.push(at);
        }
        i = at;
        if i >= chunk.len() {
            break;
        }
    }
    starts
}
