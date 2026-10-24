//! Incremental mbox traversal and compaction detection.
use super::*;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Digest a bounded byte range for an append/compaction checkpoint.
fn digest(file: &mut File, start: u64, len: u64) -> io::Result<String> {
    let mut head = Vec::new();
    file.seek(SeekFrom::Start(start))?;
    file.take(len).read_to_end(&mut head)?;
    if (head.len() as u64) < len {
        return Ok(String::new());
    }
    Ok(Sha256::digest(&head)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn checkpoint(
    file: &mut File,
    offset: u64,
    last_separator: Option<(u64, u64, String)>,
) -> io::Result<MboxCheckpoint> {
    let len = offset.min(4096);
    Ok(MboxCheckpoint {
        tail: digest(file, offset - len, len)?,
        last_separator,
    })
}

fn unchanged(file: &mut File, offset: u64, point: &MboxCheckpoint) -> io::Result<bool> {
    let len = offset.min(4096);
    if digest(file, offset - len, len)? != point.tail {
        return Ok(false);
    }
    if let Some((start, len, hash)) = &point.last_separator {
        if *len > 1024 || *start > offset || digest(file, *start, *len)? != *hash {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn scan_mbox(
    scope: &Scope,
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
    let mut file = match scope.file(path) {
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
    let (mut offset, mut last_separator) = match previous {
        Some(FolderCursor::Mbox {
            offset,
            head,
            head_len,
            checkpoint: Some(point),
        }) if *head_len <= 4096
            && *offset <= meta.len()
            && digest(&mut file, 0, *head_len)? == *head
            && unchanged(&mut file, *offset, point)? =>
        {
            (*offset, point.last_separator.clone())
        }
        _ => (0, None),
    };
    let head_len = meta.len().min(4096);
    let head = digest(&mut file, 0, head_len)?;
    if offset == meta.len() {
        return Ok(Some(FolderCursor::Mbox {
            offset,
            head,
            head_len,
            checkpoint: Some(checkpoint(&mut file, offset, last_separator)?),
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
    let Some(chunk) = read_bounded(&mut file, limits.max_mbox_bytes, limits, out)? else {
        return Ok(previous.cloned());
    };
    let base = offset;
    let complete = base + chunk.len() as u64 == meta.len();
    let starts = message_starts(&chunk, at_line_start);
    for (index, &start) in starts.iter().enumerate() {
        if expired(limits, out) {
            break;
        }
        let separator_len = chunk[start..]
            .iter()
            .position(|&b| b == b'\n')
            .unwrap_or(chunk.len() - start)
            .min(1024);
        let separator = (
            base + start as u64,
            separator_len as u64,
            Sha256::digest(&chunk[start..start + separator_len])
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
        );
        let end = match starts.get(index + 1) {
            Some(&next) => next,
            None if complete => chunk.len(),
            // The last message may continue past this chunk: next scan.
            None => {
                if index == 0 && start == 0 && chunk.len() as u64 >= limits.max_mbox_bytes {
                    // One message larger than a whole scan chunk: skip past it.
                    out.stats.skipped_large += 1;
                    // Retain enough overlap to find a separator split across chunks.
                    offset = base + chunk.len().saturating_sub(5) as u64;
                    last_separator = Some(separator);
                } else {
                    // A separator found after the tail of an oversized message
                    // starts a new message. Retry from that boundary, not beyond
                    // its partial body at this chunk's end.
                    offset = base + start as u64;
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
        last_separator = Some(separator);
    }
    if starts.is_empty() && !out.stats.deadline_reached {
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
        checkpoint: Some(checkpoint(&mut file, offset, last_separator)?),
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
