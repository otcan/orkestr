//! Thunderbird profile discovery per OS and inbox folder detection. Only
//! locations are computed here; the reader never opens the profile's
//! credential, key or cookie stores (see [`is_secret_file`]).
use crate::scoped_fs::Scope;
use crate::store::MailFolder;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux,
    MacOs,
    Windows,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// Where to look; taken from the environment by the caller (`HOME`, `APPDATA`).
#[derive(Debug, Clone)]
pub struct DiscoveryEnv {
    pub os: Os,
    pub home: Option<PathBuf>,
    pub appdata: Option<PathBuf>,
}

impl DiscoveryEnv {
    pub fn from_process() -> Self {
        Self {
            os: Os::current(),
            home: std::env::var_os("HOME").map(PathBuf::from),
            appdata: std::env::var_os("APPDATA").map(PathBuf::from),
        }
    }
}

/// Files a mail reader must never open: Thunderbird's saved passwords,
/// key and certificate stores, cookies and session state.
pub fn is_secret_file(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        "logins.json"
            | "logins-backup.json"
            | "key4.db"
            | "key3.db"
            | "cert9.db"
            | "cert8.db"
            | "signons.sqlite"
            | "cookies.sqlite"
            | "pkcs11.txt"
            | "sessionstore.jsonlz4"
            | "oauth.json"
    )
}

/// Candidate Thunderbird data roots (the directory holding `profiles.ini`).
pub fn profile_roots(env: &DiscoveryEnv) -> Vec<PathBuf> {
    let home = env.home.as_deref();
    match env.os {
        Os::Linux => home
            .map(|h| {
                vec![
                    h.join(".thunderbird"),
                    h.join("snap/thunderbird/common/.thunderbird"),
                    h.join(".var/app/org.mozilla.Thunderbird/.thunderbird"),
                ]
            })
            .unwrap_or_default(),
        Os::MacOs => home
            .map(|h| vec![h.join("Library/Thunderbird")])
            .unwrap_or_default(),
        Os::Windows => env
            .appdata
            .as_deref()
            .map(|a| vec![a.join("Thunderbird")])
            .unwrap_or_default(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub name: String,
    pub path: PathBuf,
    /// Selected by an `[Install...]` section or `Default=1`.
    pub default: bool,
}

/// Profiles listed in `<root>/profiles.ini`, the default first.
pub fn read_profiles_ini(root: &Path) -> Vec<Profile> {
    let Ok(scope) = Scope::new(root) else {
        return Vec::new();
    };
    let Ok(file) = scope.file(&root.join("profiles.ini")) else {
        return Vec::new();
    };
    let mut text = String::new();
    if file.take(512 * 1024).read_to_string(&mut text).is_err() {
        return Vec::new();
    }
    let mut sections: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for line in text.lines().take(2000) {
        let line = line.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            sections.push((name.to_owned(), Vec::new()));
        } else if let (Some((k, v)), Some(section)) = (line.split_once('='), sections.last_mut()) {
            section.1.push((k.trim().to_owned(), v.trim().to_owned()));
        }
    }
    let get = |fields: &[(String, String)], key: &str| {
        fields
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.clone())
    };
    let install_defaults: Vec<String> = sections
        .iter()
        .filter(|(name, _)| name.starts_with("Install"))
        .filter_map(|(_, fields)| get(fields, "Default"))
        .collect();
    let mut profiles: Vec<Profile> = sections
        .iter()
        .filter(|(name, _)| name.starts_with("Profile"))
        .filter_map(|(_, fields)| {
            let raw = get(fields, "Path")?;
            if raw.split(['/', '\\']).any(|c| c == "..") {
                return None;
            }
            let relative = get(fields, "IsRelative").is_none_or(|v| v == "1");
            let path = if relative {
                root.join(raw.replace('\\', "/"))
            } else {
                PathBuf::from(&raw)
            };
            let default = install_defaults.contains(&raw)
                || (install_defaults.is_empty() && get(fields, "Default").as_deref() == Some("1"));
            Some(Profile {
                name: get(fields, "Name").unwrap_or_default(),
                path,
                default,
            })
        })
        .collect();
    profiles.sort_by_key(|p| !p.default);
    profiles
}

/// All profiles under every root for this OS, default profiles first.
pub fn discover(env: &DiscoveryEnv) -> Vec<Profile> {
    let mut all: Vec<Profile> = profile_roots(env)
        .iter()
        .flat_map(|root| read_profiles_ini(root))
        .filter(|p| Scope::new(&p.path).is_ok())
        .collect();
    all.sort_by_key(|p| !p.default);
    all
}

/// Inbox folders of a profile: `ImapMail/<server>/INBOX` and
/// `Mail/<account>/Inbox`, as a Maildir directory or an mbox file, plus any
/// `extra` folder names (for example a Gmail label "Jobs").
pub fn inbox_folders(profile: &Path, extra: &[String]) -> Vec<MailFolder> {
    let mut folders = Vec::new();
    let Ok(scope) = Scope::new(profile) else {
        return folders;
    };
    for (kind, names) in [
        ("ImapMail", ["INBOX", "Inbox"]),
        ("Mail", ["Inbox", "INBOX"]),
    ] {
        let base = profile.join(kind);
        let Ok(accounts) = scope.entries(&base) else {
            continue;
        };
        let mut accounts: Vec<PathBuf> = accounts
            .flatten()
            .map(|name| base.join(name))
            .filter(|p| scope.directory(p).is_ok())
            .collect();
        accounts.sort();
        for account in accounts {
            // The inbox is `INBOX` (IMAP) or `Inbox` (local); take the first
            // that exists so case-insensitive filesystems never list it twice.
            let inbox = names
                .iter()
                .map(|n| account.join(n))
                .find(|p| folder(&scope, p).is_some());
            let extras = extra
                .iter()
                .filter(|n| {
                    !n.is_empty() && !n.contains(['/', '\\']) && *n != ".." && !is_secret_file(n)
                })
                .map(|n| account.join(n))
                .filter(|p| folder(&scope, p).is_some());
            for path in inbox.into_iter().chain(extras) {
                let Some(folder) = folder(&scope, &path) else {
                    continue;
                };
                if !folders.contains(&folder) {
                    folders.push(folder);
                }
            }
        }
    }
    folders
}

#[cfg(test)]
#[path = "profile_tests.rs"]
mod tests;

/// Sent-mail folder names Thunderbird uses (Gmail `[Gmail]/Sent Mail` and
/// its German name, generic IMAP and local folders).
const SENT: [&str; 7] = [
    "[Gmail].sbd/Sent Mail",
    "[Gmail].sbd/Gesendet",
    "[Google Mail].sbd/Gesendet",
    "[Google Mail].sbd/Sent Mail",
    "Sent",
    "Sent Messages",
    "Gesendet",
];

/// The user's sent folders of a profile (the primary source of applications).
pub fn sent_folders(profile: &Path) -> Vec<MailFolder> {
    let mut folders = Vec::new();
    let Ok(scope) = Scope::new(profile) else {
        return folders;
    };
    for kind in ["ImapMail", "Mail"] {
        let base = profile.join(kind);
        let Ok(accounts) = scope.entries(&base) else {
            continue;
        };
        let mut accounts: Vec<PathBuf> = accounts
            .flatten()
            .map(|name| base.join(name))
            .filter(|p| scope.directory(p).is_ok())
            .collect();
        accounts.sort();
        for account in accounts {
            for name in SENT {
                let path = account.join(name);
                let Some(folder) = folder(&scope, &path) else {
                    continue;
                };
                if !folders.contains(&folder) {
                    folders.push(folder);
                }
                break;
            }
        }
    }
    folders
}

fn folder(scope: &Scope, path: &Path) -> Option<MailFolder> {
    if scope.directory(path).is_ok() {
        Some(MailFolder::Maildir(path.to_owned()))
    } else if scope.file(path).is_ok() {
        Some(MailFolder::Mbox(path.to_owned()))
    } else {
        None
    }
}
