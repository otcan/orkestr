//! Incremental Maildir traversal with a bounded cursor.
use super::*;
use std::path::Path;

pub(super) fn scan_maildir(
    scope: &Scope,
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
        if expired(limits, out) {
            return Ok(previous.cloned());
        }
        let dir = root.join(sub);
        let entries = match scope.entries(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        any = true;
        for entry in entries {
            if expired(limits, out) {
                return Ok(previous.cloned());
            }
            let path = dir.join(entry?);
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if name.starts_with('.') || crate::profile::is_secret_file(&name) {
                continue;
            }
            let file = scope.file(&path)?;
            let meta = file.metadata()?;
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
            candidates.push((unique, path, meta.len()));
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
        if expired(limits, out) || out.stats.examined() >= limits.max_messages {
            out.stats.truncated = true;
            break;
        }
        if len > limits.max_message_bytes {
            out.stats.skipped_large += 1;
        } else {
            let read = scope.file(&path).and_then(|mut file| {
                read_bounded(
                    &mut file,
                    limits.max_message_bytes.saturating_add(1),
                    limits,
                    out,
                )
            });
            match read {
                Ok(Some(bytes)) if bytes.len() as u64 > limits.max_message_bytes => {
                    out.stats.skipped_large += 1;
                }
                Ok(Some(bytes)) => keep(envelope::parse(&bytes), limits, out),
                Ok(None) => break,
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
