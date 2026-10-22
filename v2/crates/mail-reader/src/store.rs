//! Read-only, bounded, incremental scan of local mail folders (Maildir or
//! mbox) with a serialisable cursor. Files are only ever opened for reading;
//! nothing is renamed, flagged, locked or deleted. Messages that may still be
//! being written (modified within `settle_ms`) wait for the next scan.
use crate::envelope::{self, Envelope};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", content = "path", rename_all = "snake_case")]
pub enum MailFolder {
    /// A directory with `cur/` and/or `new/` (one file per message).
    Maildir(PathBuf),
    /// One file of concatenated messages separated by `From ` lines.
    Mbox(PathBuf),
}

impl MailFolder {
    fn key(&self) -> String {
        match self {
            Self::Maildir(p) => format!("maildir:{}", p.display()),
            Self::Mbox(p) => format!("mbox:{}", p.display()),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub folders: BTreeMap<String, FolderCursor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FolderCursor {
    Maildir { seen: BTreeSet<String> },
    /// Bytes consumed, and a digest of the file's first 4 KiB: a different
    /// head or a shorter file (compaction) restarts from 0; the dedupe ledger
    /// then drops the messages that were already recorded.
    Mbox { offset: u64, head: String, head_len: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanLimits {
    pub max_messages: usize,
    pub max_message_bytes: u64,
    /// Most mbox bytes read per folder and scan.
    pub max_mbox_bytes: u64,
    pub settle_ms: u64,
    /// Messages dated before this are skipped (but remembered as seen).
    pub not_before_ms: Option<i64>,
    /// Maildir names remembered per folder.
    pub max_seen: usize,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_messages: 500,
            max_message_bytes: 4 * 1024 * 1024,
            max_mbox_bytes: 64 * 1024 * 1024,
            settle_ms: 2_000,
            not_before_ms: None,
            max_seen: 100_000,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanStats {
    pub folders: usize,
    pub files_seen: usize,
    pub new_messages: usize,
    pub skipped_large: usize,
    pub skipped_unsettled: usize,
    pub skipped_old: usize,
    pub skipped_expunged: usize,
    pub missing_folders: usize,
    /// More messages remain; the next scan continues from the cursor.
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct ScanOutput {
    /// New messages, oldest first (status changes apply in mail-date order).
    pub envelopes: Vec<Envelope>,
    pub cursor: Cursor,
    pub stats: ScanStats,
}

/// A folder and whether it holds the user's own sent mail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanFolder {
    pub folder: MailFolder,
    pub outgoing: bool,
}

/// Scan incoming folders only (see [`scan_folders`]).
pub fn scan(folders: &[MailFolder], cursor: &Cursor, limits: &ScanLimits, now: SystemTime) -> io::Result<ScanOutput> {
    let folders: Vec<ScanFolder> = folders
        .iter()
        .map(|f| ScanFolder { folder: f.clone(), outgoing: false })
        .collect();
    scan_folders(&folders, cursor, limits, now)
}

/// Scan every folder once; envelopes from sent folders are `outgoing`. A
/// folder that does not exist is counted, not an error.
pub fn scan_folders(folders: &[ScanFolder], cursor: &Cursor, limits: &ScanLimits, now: SystemTime) -> io::Result<ScanOutput> {
    let mut out = ScanOutput {
        envelopes: Vec::new(),
        cursor: Cursor::default(),
        stats: ScanStats::default(),
    };
    for ScanFolder { folder, outgoing } in folders {
        out.stats.folders += 1;
        let previous = cursor.folders.get(&folder.key());
        let first = out.envelopes.len();
        let next = match folder {
            MailFolder::Maildir(path) => scan_maildir(path, previous, limits, now, &mut out)?,
            MailFolder::Mbox(path) => scan_mbox(path, previous, limits, now, &mut out)?,
        };
        out.envelopes[first..].iter_mut().for_each(|e| e.outgoing = *outgoing);
        if let Some(next) = next {
            out.cursor.folders.insert(folder.key(), next);
        }
    }
    out.envelopes
        .sort_by(|a, b| a.date_ms.unwrap_or(i64::MAX).cmp(&b.date_ms.unwrap_or(i64::MAX)).then(a.message_ref.cmp(&b.message_ref)));
    Ok(out)
}

fn settled(meta: &fs::Metadata, limits: &ScanLimits, now: SystemTime) -> bool {
    let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    now.duration_since(modified)
        .is_ok_and(|age| age.as_millis() >= u128::from(limits.settle_ms))
}

fn keep(envelope: Envelope, limits: &ScanLimits, out: &mut ScanOutput) {
    if envelope.expunged {
        out.stats.skipped_expunged += 1;
    } else if limits
        .not_before_ms
        .is_some_and(|floor| envelope.date_ms.is_some_and(|d| d < floor))
    {
        out.stats.skipped_old += 1;
    } else {
        out.stats.new_messages += 1;
        out.envelopes.push(envelope);
    }
}

fn read_bounded(path: &Path, max: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(max).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn scan_maildir(
    root: &Path,
    previous: Option<&FolderCursor>,
    limits: &ScanLimits,
    now: SystemTime,
    out: &mut ScanOutput,
) -> io::Result<Option<FolderCursor>> {
    let mut seen = match previous {
        Some(FolderCursor::Maildir { seen }) => seen.clone(),
        _ => BTreeSet::new(),
    };
    let mut present = BTreeSet::new();
    let mut candidates = Vec::new();
    let mut any = false;
    for sub in ["cur", "new"] {
        let dir = root.join(sub);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        any = true;
        for entry in entries {
            let entry = entry?;
            let meta = entry.metadata()?;
            if !meta.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || crate::profile::is_secret_file(&name) {
                continue;
            }
            out.stats.files_seen += 1;
            // Flags after ":2," (or "!2," on Windows) change when mail is read.
            let unique = name.split([':', '!']).next().unwrap_or(&name).to_owned();
            present.insert(unique.clone());
            if seen.contains(&unique) {
                continue;
            }
            if !settled(&meta, limits, now) {
                out.stats.skipped_unsettled += 1;
                continue;
            }
            candidates.push((unique, entry.path(), meta.len()));
        }
    }
    if !any {
        out.stats.missing_folders += 1;
        return Ok(previous.cloned());
    }
    candidates.sort();
    for (unique, path, len) in candidates {
        if out.envelopes.len() >= limits.max_messages {
            out.stats.truncated = true;
            break;
        }
        if len > limits.max_message_bytes {
            out.stats.skipped_large += 1;
        } else {
            match read_bounded(&path, limits.max_message_bytes) {
                Ok(bytes) => keep(envelope::parse(&bytes), limits, out),
                // Removed between listing and reading: nothing to record.
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            }
        }
        seen.insert(unique);
    }
    // Forget names that left the folder; keep the cursor bounded.
    seen.retain(|name| present.contains(name));
    while seen.len() > limits.max_seen {
        let first = seen.iter().next().cloned();
        if let Some(first) = first {
            seen.remove(&first);
        }
    }
    Ok(Some(FolderCursor::Maildir { seen }))
}

/// Digest of the file's first `len` bytes.
fn head_digest(file: &mut File, len: u64) -> io::Result<String> {
    let mut head = Vec::new();
    file.seek(SeekFrom::Start(0))?;
    file.take(len).read_to_end(&mut head)?;
    if (head.len() as u64) < len {
        return Ok(String::new());
    }
    Ok(Sha256::digest(&head)[..12].iter().map(|b| format!("{b:02x}")).collect())
}

fn scan_mbox(
    path: &Path,
    previous: Option<&FolderCursor>,
    limits: &ScanLimits,
    now: SystemTime,
    out: &mut ScanOutput,
) -> io::Result<Option<FolderCursor>> {
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
        Some(FolderCursor::Mbox { offset, head, head_len })
            if *offset <= meta.len() && head_digest(&mut file, *head_len)? == *head =>
        {
            *offset
        }
        _ => 0,
    };
    let head_len = meta.len().min(4096);
    let head = head_digest(&mut file, head_len)?;
    if offset == meta.len() {
        return Ok(Some(FolderCursor::Mbox { offset, head, head_len }));
    }
    if !settled(&meta, limits, now) {
        out.stats.skipped_unsettled += 1;
        return Ok(previous.cloned());
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut chunk = Vec::new();
    (&mut file)
        .take(limits.max_mbox_bytes)
        .read_to_end(&mut chunk)?;
    let base = offset;
    let complete = base + chunk.len() as u64 == meta.len();
    let starts = message_starts(&chunk);
    for (index, &start) in starts.iter().enumerate() {
        let end = match starts.get(index + 1) {
            Some(&next) => next,
            None if complete => chunk.len(),
            // The last message may continue past this chunk: next scan.
            None => {
                if index == 0 && chunk.len() as u64 >= limits.max_mbox_bytes {
                    // One message larger than a whole scan chunk: skip past it.
                    out.stats.skipped_large += 1;
                    offset = base + chunk.len() as u64;
                }
                out.stats.truncated = true;
                break;
            }
        };
        if out.envelopes.len() >= limits.max_messages {
            out.stats.truncated = true;
            break;
        }
        let message = &chunk[start..end];
        // Drop the `From ` separator line itself.
        let body_start = message.iter().position(|&b| b == b'\n').map_or(message.len(), |p| p + 1);
        if (message.len() as u64) > limits.max_message_bytes {
            out.stats.skipped_large += 1;
        } else {
            keep(envelope::parse(&message[body_start..]), limits, out);
        }
        offset = base + end as u64;
    }
    if starts.is_empty() && complete {
        offset = meta.len();
    }
    Ok(Some(FolderCursor::Mbox { offset, head, head_len }))
}

/// Byte offsets of `From ` separator lines (at the start, or after a newline).
fn message_starts(chunk: &[u8]) -> Vec<usize> {
    let mut starts = Vec::new();
    if chunk.starts_with(b"From ") {
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

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
