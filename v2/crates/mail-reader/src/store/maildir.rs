//! Incremental Maildir traversal with a bounded cursor.
use super::*;
use std::fs::File;
use std::io::Read;
use std::path::Path;

fn read_bounded(path: &Path, max: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(max).read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub(super) fn scan_maildir(
    root: &Path,
    previous: Option<&FolderCursor>,
    limits: &ScanLimits,
    now: SystemTime,
    out: &mut ScanOutput,
) -> io::Result<Option<FolderCursor>> {
    let mut after = match previous {
        Some(FolderCursor::Maildir { after, .. }) => after.clone(),
        _ => None,
    };
    let mut seen = match previous {
        Some(FolderCursor::Maildir { seen, .. }) => seen.clone(),
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
    candidates.dedup_by(|a, b| a.0 == b.0);
    let split =
        candidates.partition_point(|(name, _, _)| after.as_ref().is_some_and(|last| name <= last));
    candidates.rotate_left(split);
    for (unique, path, len) in candidates {
        if out.stats.examined() >= limits.max_messages {
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
        after = Some(unique.clone());
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
    Ok(Some(FolderCursor::Maildir { seen, after }))
}
