//! A value-free catalog of the OpenBao store, written by a root job.
//!
//! Listing a large store through the API would read every credential's
//! metadata on every page load, and each read is a line in the store's audit
//! log. A root job that already follows that log refreshes only what changed
//! and writes this file (`catalog` in the backend configuration):
//!
//! ```json
//! {"format": "orkestr-credentials-catalog-v1", "generated_at_ms": 1700000000000,
//!  "credentials": [{"id": "search", "type": "api_key", "site": "search.example.com", "label": "Search",
//!                   "allowed": ["<conversation id>", "owner-desks"], "version": 3,
//!                   "updated_time": "2026-01-01T00:00:00Z"}]}
//! ```
//!
//! Deleted credentials are left out. A missing, refused or stale file makes
//! the server read the store directly instead (bounded).
use super::model::{self, CredentialView, Kind, Usage, OWNER_DESKS};
use serde::Deserialize;

pub(crate) const FORMAT: &str = "orkestr-credentials-catalog-v1";
const MAX_FILE: usize = 16 * 1024 * 1024;
/// The job runs every minute; after this the store is read directly.
const STALE_MS: i64 = 15 * 60 * 1000;
const MAX_ENTRIES: usize = 20_000;

#[derive(Deserialize)]
struct File {
    format: String,
    generated_at_ms: i64,
    #[serde(default)]
    credentials: Vec<Entry>,
}
#[derive(Deserialize)]
struct Entry {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    site: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    allowed: Vec<String>,
    version: i64,
    #[serde(default)]
    updated_time: String,
}

pub(crate) struct Catalog {
    pub(crate) generated_at_ms: i64,
    pub(crate) rows: Vec<CredentialView>,
}

impl Catalog {
    pub(crate) fn parse(text: &str, now_ms: i64) -> Option<Catalog> {
        let file = serde_json::from_str::<File>(text).ok()?;
        if file.format != FORMAT
            || now_ms - file.generated_at_ms > STALE_MS
            || file.credentials.len() > MAX_ENTRIES
        {
            return None;
        }
        let mut rows: Vec<CredentialView> = Vec::new();
        for entry in file.credentials {
            let Some(row) = row(entry) else { continue };
            if !rows.iter().any(|r| r.id == row.id) {
                rows.push(row);
            }
        }
        Some(Catalog {
            generated_at_ms: file.generated_at_ms,
            rows,
        })
    }

    pub(crate) fn load(path: &std::path::Path, now_ms: i64) -> Option<Catalog> {
        match super::private_file::read(path, MAX_FILE, false) {
            Ok(Some(text)) => Catalog::parse(&text, now_ms),
            _ => None,
        }
    }
}

fn row(entry: Entry) -> Option<CredentialView> {
    if !model::slug_valid(&entry.id) || entry.version < 1 || entry.updated_time.len() > 64 {
        return None;
    }
    let kind = Kind::parse(&entry.kind)?;
    let site = entry.site.to_ascii_lowercase();
    let site = if model::domain(&site) {
        site
    } else {
        String::new()
    };
    let mut owner_desks = false;
    let mut allowed: Vec<String> = Vec::new();
    for id in entry.allowed.iter().take(64) {
        if id == OWNER_DESKS {
            owner_desks = true;
        } else if let Ok(uuid) = uuid::Uuid::parse_str(id) {
            let id = uuid.hyphenated().to_string();
            if !allowed.contains(&id) {
                allowed.push(id);
            }
        }
    }
    let label = match entry.label.trim() {
        "" => entry.id.clone(),
        label if label.chars().any(char::is_control) => entry.id.clone(),
        label => label.chars().take(200).collect(),
    };
    Some(CredentialView {
        revision: format!("{}:{}", entry.version, entry.updated_time),
        updated_at_ms: super::openbao::rfc3339_ms(&entry.updated_time),
        id: entry.id,
        label,
        kind,
        site,
        allowed,
        owner_desks,
        fields: Vec::new(),
        usage: Usage::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_catalog_lists_rows_without_reading_the_store() {
        let chat = "00000000-0000-4000-8000-00000000000a";
        let text = json!({"format": FORMAT, "generated_at_ms": 1_000_000, "credentials": [
            {"id": "search", "type": "api_key", "site": "search.example.com", "label": "Search", "allowed": [chat, "owner-desks", "junk"], "version": 2, "updated_time": "2026-11-14T13:15:08Z"},
            {"id": "search", "type": "api_key", "label": "duplicate", "version": 1},
            {"id": "Bad Id", "type": "password", "version": 1},
            {"id": "ssh", "type": "ssh_key", "version": 1},
            {"id": "portal", "type": "password", "site": "not a site", "version": 4, "updated_time": "x"}]}).to_string();
        let catalog = Catalog::parse(&text, 1_000_000 + 60_000).unwrap();
        let ids: Vec<&str> = catalog.rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["search", "portal"]);
        let search = &catalog.rows[0];
        assert_eq!(
            (
                search.allowed.clone(),
                search.owner_desks,
                search.revision.as_str()
            ),
            (vec![chat.to_string()], true, "2:2026-11-14T13:15:08Z")
        );
        assert_eq!(
            (
                catalog.rows[1].site.as_str(),
                catalog.rows[1].label.as_str()
            ),
            ("", "portal")
        );
    }

    #[test]
    fn a_stale_or_foreign_catalog_is_not_used() {
        let text = json!({"format": FORMAT, "generated_at_ms": 0, "credentials": []}).to_string();
        assert!(Catalog::parse(&text, STALE_MS + 1).is_none());
        assert!(Catalog::parse(&text, STALE_MS).is_some());
        assert!(Catalog::parse(r#"{"format":"other","generated_at_ms":0}"#, 0).is_none());
        assert!(Catalog::parse("not json", 0).is_none());
    }
}
