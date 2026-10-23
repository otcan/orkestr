//! Read-only, bounded, incremental scan of local mail folders (Maildir or
//! mbox) with a serialisable cursor. Files are only ever opened for reading;
//! nothing is renamed, flagged, locked or deleted. Messages that may still be
//! being written (modified within `settle_ms`) wait for the next scan.
use crate::envelope::{self, Envelope};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::SystemTime;

mod maildir;
mod mbox;
use maildir::scan_maildir;
use mbox::scan_mbox;

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
    Maildir {
        seen: BTreeSet<String>,
        /// Resume cyclically after the last visited name, so eviction from a
        /// bounded `seen` set never starves later mail in a large folder.
        #[serde(default)]
        after: Option<String>,
    },
    /// Bytes consumed, and a digest of the file's first 4 KiB: a different
    /// head or a shorter file (compaction) restarts from 0; the dedupe ledger
    /// then drops the messages that were already recorded.
    Mbox {
        offset: u64,
        head: String,
        head_len: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanLimits {
    /// Messages examined per scan, including old, expunged and oversized mail.
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

impl ScanStats {
    fn examined(&self) -> usize {
        self.new_messages + self.skipped_large + self.skipped_old + self.skipped_expunged
    }
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
pub fn scan(
    folders: &[MailFolder],
    cursor: &Cursor,
    limits: &ScanLimits,
    now: SystemTime,
) -> io::Result<ScanOutput> {
    let folders: Vec<ScanFolder> = folders
        .iter()
        .map(|f| ScanFolder {
            folder: f.clone(),
            outgoing: false,
        })
        .collect();
    scan_folders(&folders, cursor, limits, now)
}

/// Scan every folder once; envelopes from sent folders are `outgoing`. A
/// folder that does not exist is counted, not an error.
pub fn scan_folders(
    folders: &[ScanFolder],
    cursor: &Cursor,
    limits: &ScanLimits,
    now: SystemTime,
) -> io::Result<ScanOutput> {
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
        out.envelopes[first..]
            .iter_mut()
            .for_each(|e| e.outgoing = *outgoing);
        if let Some(next) = next {
            out.cursor.folders.insert(folder.key(), next);
        }
    }
    out.envelopes.sort_by(|a, b| {
        a.date_ms
            .unwrap_or(i64::MAX)
            .cmp(&b.date_ms.unwrap_or(i64::MAX))
            .then(a.message_ref.cmp(&b.message_ref))
    });
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

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
