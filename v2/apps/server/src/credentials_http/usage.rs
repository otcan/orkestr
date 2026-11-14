//! "Used by" and "last used": a value-free summary of the store's audit log.
//!
//! The audit log itself stays with root; a root job writes this summary,
//! typically every minute, to a file this server may read (`usage_summary`
//! in the backend configuration, by default `<home>/credentials-usage.json`):
//!
//! ```json
//! {"format": "orkestr-credentials-usage-v1", "generated_at_ms": 1700000000000,
//!  "credentials": {"<credential id>": {
//!     "last_used_at_ms": 1700000000000, "last_used_by": "<chat id>",
//!     "chats": [{"id": "<chat id>", "last_at_ms": 1700000000000, "uses": 3}],
//!     "last_sign_in": {"at_ms": 1700000000000, "result": "failed", "outcome": "login_failed"}}}}
//! ```
//!
//! Ids, times, counts and fixed outcome codes only. A missing, refused or
//! malformed file shows every credential as "never used" with no error.
use super::model::{ChatUse, Status, Usage};
use serde::Deserialize;
use std::collections::BTreeMap;

pub(crate) const FORMAT: &str = "orkestr-credentials-usage-v1";
const MAX_FILE: usize = 4 * 1024 * 1024;
/// Older than this, the page says the usage columns may be behind.
const STALE_MS: i64 = 10 * 60 * 1000;
const MAX_CHATS: usize = 50;

#[derive(Deserialize)]
struct File {
    format: String,
    generated_at_ms: i64,
    #[serde(default)]
    credentials: BTreeMap<String, Entry>,
}
#[derive(Deserialize, Default)]
struct Entry {
    #[serde(default)]
    last_used_at_ms: Option<i64>,
    #[serde(default)]
    last_used_by: Option<String>,
    #[serde(default)]
    chats: Vec<Chat>,
    #[serde(default)]
    last_sign_in: Option<SignIn>,
}
#[derive(Deserialize)]
struct Chat {
    id: String,
    last_at_ms: i64,
    #[serde(default)]
    uses: u64,
}
#[derive(Deserialize)]
struct SignIn {
    at_ms: i64,
    result: String,
    #[serde(default)]
    outcome: Option<String>,
}

/// The parsed summary, or nothing.
#[derive(Default)]
pub(crate) struct Summary {
    pub(crate) generated_at_ms: Option<i64>,
    entries: BTreeMap<String, Usage>,
}

fn chat_id(text: &str) -> bool {
    (1..=200).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn code(text: &str) -> bool {
    (1..=64).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_:-".contains(&b))
}
fn time(ms: i64) -> bool {
    (0..=4_102_444_800_000).contains(&ms)
}

impl Summary {
    pub(crate) fn parse(text: &str) -> Summary {
        let Ok(file) = serde_json::from_str::<File>(text) else {
            return Summary::default();
        };
        if file.format != FORMAT || !time(file.generated_at_ms) {
            return Summary::default();
        }
        let mut entries = BTreeMap::new();
        for (id, entry) in file.credentials.into_iter().take(10_000) {
            if !chat_id(&id) {
                continue;
            }
            entries.insert(id, usage(entry));
        }
        Summary {
            generated_at_ms: Some(file.generated_at_ms),
            entries,
        }
    }

    pub(crate) fn load(path: &std::path::Path) -> Summary {
        match super::private_file::read(path, MAX_FILE, false) {
            Ok(Some(text)) => Summary::parse(&text),
            _ => Summary::default(),
        }
    }

    pub(crate) fn stale(&self, now_ms: i64) -> bool {
        self.generated_at_ms.is_none_or(|at| now_ms - at > STALE_MS)
    }

    /// The usage of one credential; "never used" when the summary has none.
    pub(crate) fn of(&self, id: &str) -> Usage {
        self.entries.get(id).cloned().unwrap_or_default()
    }

    /// Adds uses the store reports itself (the built-in vault's own audit).
    pub(crate) fn merge(&mut self, id: &str, at_ms: i64, chat: Option<&str>) {
        let usage = self.entries.entry(id.to_owned()).or_default();
        if usage.last_used_at_ms.is_none_or(|last| at_ms > last) {
            usage.last_used_at_ms = Some(at_ms);
            usage.last_used_by = chat.filter(|c| chat_id(c)).map(str::to_owned);
        }
        if let Some(chat) = chat.filter(|c| chat_id(c)) {
            match usage.chats.iter().position(|c| c.id == chat) {
                Some(at) => {
                    let seen = &mut usage.chats[at];
                    seen.uses += 1;
                    seen.last_at_ms = seen.last_at_ms.max(at_ms);
                }
                None if usage.chats.len() < MAX_CHATS => usage.chats.push(ChatUse {
                    id: chat.to_owned(),
                    last_at_ms: at_ms,
                    uses: 1,
                }),
                None => {}
            }
        }
        if usage.status == Status::NeverUsed {
            usage.status = Status::Ok;
        }
    }
}

fn usage(entry: Entry) -> Usage {
    let mut chats: Vec<ChatUse> = entry
        .chats
        .into_iter()
        .filter(|c| chat_id(&c.id) && time(c.last_at_ms))
        .map(|c| ChatUse {
            id: c.id,
            last_at_ms: c.last_at_ms,
            uses: c.uses,
        })
        .collect();
    // One row per chat (its latest), newest first.
    chats.sort_by(|a, b| a.id.cmp(&b.id).then(b.last_at_ms.cmp(&a.last_at_ms)));
    chats.dedup_by(|later, kept| later.id == kept.id);
    chats.sort_by(|a, b| b.last_at_ms.cmp(&a.last_at_ms).then(a.id.cmp(&b.id)));
    chats.truncate(MAX_CHATS);
    let last_used_at_ms = entry.last_used_at_ms.filter(|t| time(*t));
    let last_used_by = entry
        .last_used_by
        .filter(|c| chat_id(c) && last_used_at_ms.is_some());
    let sign_in = entry
        .last_sign_in
        .filter(|s| time(s.at_ms) && ["ok", "failed", "needs_2fa"].contains(&s.result.as_str()));
    let (status, status_at_ms, status_detail) = match sign_in {
        Some(s) => (
            match s.result.as_str() {
                "ok" => Status::Ok,
                "needs_2fa" => Status::NeedsTwoFactor,
                _ => Status::Failed,
            },
            Some(s.at_ms),
            s.outcome.filter(|o| code(o)),
        ),
        None if last_used_at_ms.is_some() || !chats.is_empty() => (Status::Ok, None, None),
        None => (Status::NeverUsed, None, None),
    };
    Usage {
        last_used_at_ms,
        last_used_by,
        chats,
        status,
        status_at_ms,
        status_detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAT: &str = "00000000-0000-4000-8000-00000000000a";

    #[test]
    fn the_summary_gives_used_by_last_used_and_the_sign_in_status() {
        let text = serde_json::json!({"format": FORMAT, "generated_at_ms": 1_700_000_000_000_i64, "credentials": {
            "search": {"last_used_at_ms": 1_699_999_000_000_i64, "last_used_by": CHAT,
                       "chats": [{"id": CHAT, "last_at_ms": 1_699_999_000_000_i64, "uses": 4}]},
            "portal": {"last_sign_in": {"at_ms": 1_699_998_000_000_i64, "result": "needs_2fa", "outcome": "code_required"}},
            "broken": {"last_sign_in": {"at_ms": 1, "result": "failed", "outcome": "Not A Code"}},
            "bad id!": {"last_used_at_ms": 1}}}).to_string();
        let summary = Summary::parse(&text);
        let search = summary.of("search");
        assert_eq!(
            (search.status, search.last_used_by.as_deref()),
            (Status::Ok, Some(CHAT))
        );
        assert_eq!(search.chats[0].uses, 4);
        let portal = summary.of("portal");
        assert_eq!(
            (portal.status, portal.status_detail.as_deref()),
            (Status::NeedsTwoFactor, Some("code_required"))
        );
        let broken = summary.of("broken");
        assert_eq!(
            (broken.status, broken.status_detail),
            (Status::Failed, None)
        );
        assert_eq!(summary.of("bad id!").status, Status::NeverUsed);
        assert_eq!(summary.of("unknown").status, Status::NeverUsed);
        assert!(!summary.stale(1_700_000_060_000) && summary.stale(1_700_001_000_000));
    }

    #[test]
    fn a_foreign_or_broken_file_means_no_usage_yet() {
        for text in [
            "",
            "{}",
            r#"{"format":"other","generated_at_ms":1}"#,
            "[1,2]",
        ] {
            let summary = Summary::parse(text);
            assert!(summary.generated_at_ms.is_none() && summary.stale(0));
        }
    }

    #[test]
    fn store_reported_uses_merge_into_the_summary() {
        let mut summary = Summary::default();
        summary.merge("vi_item", 10, Some(CHAT));
        summary.merge("vi_item", 30, Some(CHAT));
        summary.merge("vi_item", 20, None);
        let usage = summary.of("vi_item");
        assert_eq!(
            (usage.last_used_at_ms, usage.last_used_by.as_deref()),
            (Some(30), Some(CHAT))
        );
        assert_eq!(
            (usage.chats.len(), usage.chats[0].uses, usage.status),
            (1, 2, Status::Ok)
        );
    }
}
