//! Incremental transcript reading: every `.jsonl` file under the configured
//! sources that changed in the last eight days is read from its byte cursor
//! to the last complete line, within a per-pass byte budget (newest files
//! first, so a cold start shows the present before it backfills the week).
//! Files are identified by device and inode, so a moved (archived) rollout
//! keeps its cursor.
use super::{
    config::Source,
    ledger::{Ledger, KEEP_MINUTES},
    parse::{claude_line, CodexState},
};
use orkestr_v2_contracts::AiProvider;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const MAX_DEPTH: usize = 7;
const MAX_FILES: usize = 50_000;
/// Longest line kept in memory; longer lines are skipped whole.
const MAX_LINE: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Cursor {
    pub source: u16,
    pub offset: u64,
    /// The file's session (Codex) or the session of its last line (Claude).
    pub session: Option<u32>,
    #[serde(default)]
    pub codex: CodexState,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub(crate) struct SourceStats {
    pub readable: bool,
    pub files: u32,
}

/// Files of one source changed since `since_s` (Unix seconds), newest first.
pub(crate) fn discover(root: &Path, since_s: i64) -> Option<Vec<(PathBuf, std::fs::Metadata)>> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_owned(), 0usize)];
    std::fs::read_dir(root).ok()?;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
            } else if kind.is_file()
                && path.extension().is_some_and(|e| e == "jsonl")
                && out.len() < MAX_FILES
            {
                if let Ok(meta) = entry.metadata() {
                    if meta.mtime() >= since_s {
                        out.push((path, meta));
                    }
                }
            }
        }
    }
    out.sort_by_key(|(_, m)| std::cmp::Reverse(m.mtime()));
    Some(out)
}

pub(crate) struct Scanner {
    pub cursors: HashMap<(u64, u64), Cursor>,
    pub stats: Vec<SourceStats>,
    /// Bytes left to read in a pass with work still pending.
    pub pending_bytes: u64,
    pub total_bytes: u64,
    /// The last pass stopped at its byte budget (more to read).
    pub exhausted: bool,
}

impl Scanner {
    pub fn new(cursors: HashMap<(u64, u64), Cursor>) -> Self {
        Scanner {
            cursors,
            stats: Vec::new(),
            pending_bytes: 0,
            total_bytes: 0,
            exhausted: false,
        }
    }

    /// One pass over all sources; reads at most `budget` bytes.
    pub fn pass(&mut self, sources: &[Source], ledger: &mut Ledger, now_ms: i64, budget: u64) {
        // File times follow the wall clock (records are checked against `now_ms`).
        let since = super::now_ms() / 1000 - KEEP_MINUTES * 60 - 3600;
        let mut files = Vec::new();
        self.stats = vec![SourceStats::default(); sources.len()];
        for (i, source) in sources.iter().enumerate() {
            if let Some(found) = discover(&source.path, since) {
                self.stats[i] = SourceStats {
                    readable: true,
                    files: found.len() as u32,
                };
                files.extend(found.into_iter().map(|(p, m)| (i as u16, p, m)));
            }
        }
        files.sort_by_key(|(_, _, m)| std::cmp::Reverse(m.mtime()));
        let mut live = HashMap::with_capacity(files.len());
        let (mut left, mut pending, mut total) = (budget, 0u64, 0u64);
        for (source, path, meta) in files {
            let key = (meta.dev(), meta.ino());
            let mut cursor = self.cursors.remove(&key).unwrap_or(Cursor {
                source,
                offset: 0,
                session: None,
                codex: CodexState::default(),
            });
            if meta.len() < cursor.offset {
                // Truncated or replaced in place: start over.
                cursor = Cursor {
                    source,
                    offset: 0,
                    session: None,
                    codex: CodexState::default(),
                };
            }
            cursor.source = source;
            total += meta.len();
            let unread = meta.len() - cursor.offset;
            if unread > 0 && left > 0 {
                let src = &sources[source as usize];
                let read = read_file(&path, &mut cursor, src, ledger, now_ms, left);
                left = left.saturating_sub(read.max(1));
            }
            pending += meta.len() - cursor.offset;
            live.insert(key, cursor);
        }
        // Files that vanished or aged out are forgotten.
        self.cursors = live;
        self.pending_bytes = pending;
        self.total_bytes = total;
        self.exhausted = left == 0;
    }
}

fn session_id_from_path(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim_start_matches("agent-").to_owned())
}

/// Reads complete lines from the cursor; returns bytes consumed.
fn read_file(
    path: &Path,
    cursor: &mut Cursor,
    source: &Source,
    ledger: &mut Ledger,
    now_ms: i64,
    budget: u64,
) -> u64 {
    let Ok(mut file) = std::fs::File::open(path) else {
        return 0;
    };
    if file.seek(SeekFrom::Start(cursor.offset)).is_err() {
        return 0;
    }
    let mut reader = BufReader::with_capacity(1 << 20, (&mut file).take(budget.max(1 << 20)));
    let mut line = Vec::new();
    let mut consumed = 0u64;
    loop {
        line.clear();
        let n = match reader.by_ref().take(MAX_LINE as u64).read_until(b'\n', &mut line) {
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 || line.last() != Some(&b'\n') {
            if n >= MAX_LINE {
                // Oversized line: skip to its end without keeping it.
                let mut skipped = n as u64;
                loop {
                    line.clear();
                    match reader.by_ref().take(MAX_LINE as u64).read_until(b'\n', &mut line) {
                        Ok(0) | Err(_) => return consumed,
                        Ok(m) => {
                            skipped += m as u64;
                            if line.last() == Some(&b'\n') {
                                break;
                            }
                        }
                    }
                }
                consumed += skipped;
                cursor.offset += skipped;
                continue;
            }
            // A line still being written: read it next pass.
            break;
        }
        consumed += n as u64;
        cursor.offset += n as u64;
        apply(&line, path, cursor, source, ledger, now_ms);
        if consumed >= budget {
            break;
        }
    }
    consumed
}

pub(crate) fn apply(
    line: &[u8],
    path: &Path,
    cursor: &mut Cursor,
    source: &Source,
    ledger: &mut Ledger,
    now_ms: i64,
) {
    match source.provider {
        AiProvider::Claude => {
            let Some(parsed) = claude_line(line) else {
                return;
            };
            let t = parsed
                .usage
                .as_ref()
                .map(|u| u.t_ms)
                .or(parsed.limit.as_ref().map(|l| l.t_ms))
                .unwrap_or(now_ms);
            if let Some(limit) = &parsed.limit {
                ledger.limit(AiProvider::Claude, source.account(), limit);
            }
            let Some(usage) = parsed.usage else { return };
            let main = parsed
                .session_id
                .clone()
                .or_else(|| session_id_from_path(path));
            let (id, parent) = match &parsed.agent_id {
                Some(agent) => (format!("agent:{agent}"), main),
                None => match main {
                    Some(main) => (main, None),
                    None => return,
                },
            };
            let index = ledger.session(AiProvider::Claude, &id, cursor.source, t);
            let session = &mut ledger.sessions[index as usize];
            if session.cwd.is_none() {
                session.cwd = parsed.cwd;
            }
            if parsed.agent_id.is_some() {
                session.parent = parent;
                session.agent = parsed.agent_type.or(Some("agent".into()));
            }
            cursor.session = Some(index);
            ledger.record(index, &usage, now_ms);
        }
        AiProvider::Codex => {
            let Some(parsed) = cursor.codex.line(line) else {
                return;
            };
            for limit in &parsed.limits {
                ledger.limit(AiProvider::Codex, source.account(), limit);
            }
            if let Some(meta) = parsed.meta {
                if cursor.session.is_none() {
                    let index = ledger.session(AiProvider::Codex, &meta.id, cursor.source, now_ms);
                    let session = &mut ledger.sessions[index as usize];
                    session.cwd = meta.cwd;
                    session.parent = meta.parent;
                    session.agent = meta.agent;
                    cursor.session = Some(index);
                }
            }
            if let Some(usage) = parsed.usage {
                let index = match cursor.session {
                    Some(i) => i,
                    None => {
                        // No session_meta (should not happen): the file name's id.
                        let Some(id) = path
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .and_then(|s| s.get(s.len().saturating_sub(36)..))
                        else {
                            return;
                        };
                        let i = ledger.session(AiProvider::Codex, id, cursor.source, usage.t_ms);
                        cursor.session = Some(i);
                        i
                    }
                };
                ledger.record(index, &usage, now_ms);
            }
        }
    }
}
