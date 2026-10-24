//! Private path/identity resolver. Only opaque descriptions cross HTTP.
use crate::tracker_scan_pool::ReadFailure;
use orkestr_v2_contracts::tracker_actions::{
    SelectedMailSource, TrackerMailFolder, TrackerMailSource,
};
use orkestr_v2_mail_reader::{profile, MailFolder, ScanFolder};
use orkestr_v2_store_sqlite::history_import::timers::scan_action::TrackerLocalSource;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
pub(crate) struct BackingSource {
    profile: PathBuf,
    identity: (u64, u64),
    folders: Vec<BackingFolder>,
}
#[derive(Serialize, Deserialize)]
struct BackingFolder {
    id: Uuid,
    folder: MailFolder,
    outgoing: bool,
}
pub(crate) struct Discovery {
    pub sources: Vec<TrackerMailSource>,
    pub backing: Vec<TrackerLocalSource>,
}
pub(crate) struct ResolvedSource {
    pub profile: PathBuf,
    pub identity: (u64, u64),
    pub folders: Vec<ScanFolder>,
}

#[cfg(unix)]
fn identity(path: &Path) -> Result<(u64, u64), ReadFailure> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(path).map_err(|_| ReadFailure::Unavailable)?;
    if !meta.is_dir() || meta.is_symlink() {
        return Err(ReadFailure::Unavailable);
    }
    Ok((meta.dev(), meta.ino()))
}
#[cfg(not(unix))]
fn identity(_: &Path) -> Result<(u64, u64), ReadFailure> {
    Err(ReadFailure::Unavailable)
}

fn label(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect()
}
fn folder_label(folder: &MailFolder, outgoing: bool) -> String {
    let path = match folder {
        MailFolder::Mbox(p) | MailFolder::Maildir(p) => p,
    };
    let account = path
        .ancestors()
        .nth(1)
        .and_then(Path::file_name)
        .and_then(|s| s.to_str())
        .map(label)
        .unwrap_or_default();
    format!("{} · {}", if outgoing { "Sent" } else { "Inbox" }, account)
}

/// Invoked only by an explicit owner request on the bounded local I/O pool.
pub(crate) fn discover(env: profile::DiscoveryEnv) -> Result<Discovery, ReadFailure> {
    if !cfg!(unix) {
        return Err(ReadFailure::Unavailable);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut result = Discovery {
        sources: Vec::new(),
        backing: Vec::new(),
    };
    for profile in profile::discover(&env).into_iter().take(16) {
        if Instant::now() >= deadline {
            break;
        }
        let root_identity = identity(&profile.path)?;
        let id = Uuid::new_v4();
        let mut source = TrackerMailSource {
            id,
            label: label(&profile.name),
            inbox: Vec::new(),
            sent: Vec::new(),
            ready: false,
        };
        let mut backing = BackingSource {
            profile: profile.path.clone(),
            identity: root_identity,
            folders: Vec::new(),
        };
        for (outgoing, folders) in [
            (false, profile::inbox_folders(&profile.path, &[])),
            (true, profile::sent_folders(&profile.path)),
        ] {
            for folder in folders.into_iter().take(16) {
                if Instant::now() >= deadline {
                    break;
                }
                let id = Uuid::new_v4();
                let card = TrackerMailFolder {
                    id,
                    label: folder_label(&folder, outgoing),
                };
                if outgoing {
                    source.sent.push(card);
                } else {
                    source.inbox.push(card);
                }
                backing.folders.push(BackingFolder {
                    id,
                    folder,
                    outgoing,
                });
            }
        }
        source.ready = !source.inbox.is_empty() && !source.sent.is_empty();
        result.backing.push(TrackerLocalSource {
            source_id: id,
            backing_json: serde_json::to_string(&backing).map_err(|_| ReadFailure::Unavailable)?,
        });
        result.sources.push(source);
    }
    Ok(result)
}

/// Resolve only selected registered folders; direction is trusted registry data.
/// Root replacement requires fresh discovery and a new explicit source decision.
pub(crate) fn resolve(
    backing: &str,
    selected: &SelectedMailSource,
) -> Result<ResolvedSource, ReadFailure> {
    let backing: BackingSource =
        serde_json::from_str(backing).map_err(|_| ReadFailure::Unavailable)?;
    if !selected.is_valid() || identity(&backing.profile)? != backing.identity {
        return Err(ReadFailure::Unavailable);
    }
    let mut folders = Vec::new();
    for (outgoing, ids) in [(false, &selected.inbox), (true, &selected.sent)] {
        // Scoped no-follow traversal in the reader refuses symlinked parents,
        // credential files and hard-linked mail; this checks current readiness.
        let present = if outgoing {
            profile::sent_folders(&backing.profile)
        } else {
            profile::inbox_folders(&backing.profile, &[])
        };
        for id in ids {
            let folder = backing
                .folders
                .iter()
                .find(|f| f.id == *id && f.outgoing == outgoing)
                .ok_or(ReadFailure::Unavailable)?;
            if !present.contains(&folder.folder) {
                return Err(ReadFailure::Unavailable);
            }
            folders.push(ScanFolder {
                folder: folder.folder.clone(),
                outgoing,
            });
        }
    }
    if identity(&backing.profile)? != backing.identity {
        return Err(ReadFailure::Unavailable);
    }
    Ok(ResolvedSource {
        profile: backing.profile,
        identity: backing.identity,
        folders,
    })
}
