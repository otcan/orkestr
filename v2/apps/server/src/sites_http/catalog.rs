//! The host's catalog of published sites (ORK-834, `docs/v2/sites.md`).
//!
//! A root tool publishes a chat's static folder (or registers an app) at
//! `https://<slug>.<sites domain>/` and then rewrites this file atomically:
//!
//! ```json
//! {"format": "orkestr-sites-catalog-v1", "generated_at_ms": 1763208000000,
//!  "sites": [{"slug": "notes", "title": "Team notes", "url": "https://notes.sites.example.com/",
//!             "kind": "static", "conversation_id": "<conversation id or null>",
//!             "published_at_ms": 1763207000000, "version": "v0003", "versions": 3,
//!             "status": "live"}]}
//! ```
//!
//! It names sites, never their content, and the server never fetches one.
//! An entry that breaks the contract is dropped on its own; a file that cannot
//! be used at all gives an empty list and a fixed code.
use serde::{Deserialize, Serialize};
use std::path::Path;

pub(crate) const FORMAT: &str = "orkestr-sites-catalog-v1";
pub(crate) const MAX_FILE: usize = 1024 * 1024;
pub(crate) const MAX_SITES: usize = 2_000;
const MAX_TITLE_CHARS: usize = 200;
const MAX_URL: usize = 512;
const MAX_VERSION: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Kind {
    Static,
    App,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    Live,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Site {
    pub(crate) slug: String,
    /// May be empty: the page shows the slug instead.
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) kind: Kind,
    pub(crate) conversation_id: Option<String>,
    pub(crate) published_at_ms: i64,
    pub(crate) version: Option<String>,
    pub(crate) versions: u32,
    pub(crate) status: Status,
}

/// What `GET /api/v2/sites` answers.
#[derive(Debug, Default, PartialEq, Serialize)]
pub(crate) struct Listing {
    /// A catalog file exists (even one that was refused).
    pub(crate) configured: bool,
    /// Why the file was not used: a fixed code, never its content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<&'static str>,
    pub(crate) sites: Vec<Site>,
}

impl Listing {
    pub(crate) fn refused(code: &'static str) -> Self {
        Listing {
            configured: true,
            error: Some(code),
            sites: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
struct File {
    format: String,
    #[allow(dead_code)] // required by the contract; nothing is stale by age
    generated_at_ms: i64,
    #[serde(default)]
    sites: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct Entry {
    slug: String,
    #[serde(default)]
    title: Option<String>,
    url: String,
    kind: String,
    #[serde(default)]
    conversation_id: Option<String>,
    published_at_ms: i64,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    versions: Option<u32>,
    status: String,
}

/// The file's text to its sites, newest publish first.
pub(crate) fn parse(text: &str) -> Result<Vec<Site>, &'static str> {
    let file = serde_json::from_str::<File>(text).map_err(|_| "invalid_json")?;
    if file.format != FORMAT {
        return Err("unknown_format");
    }
    if file.sites.len() > MAX_SITES {
        return Err("too_many_sites");
    }
    let mut sites: Vec<Site> = Vec::new();
    for value in file.sites {
        let Some(site) = serde_json::from_value::<Entry>(value).ok().and_then(site) else {
            continue;
        };
        if !sites.iter().any(|s| s.slug == site.slug) {
            sites.push(site);
        }
    }
    sites.sort_by(|a, b| {
        b.published_at_ms
            .cmp(&a.published_at_ms)
            .then_with(|| a.slug.cmp(&b.slug))
    });
    Ok(sites)
}

/// Reads the file with its custody checked: root or this server's user, no
/// writes by group or others, one link, a regular file.
pub(crate) fn load(path: &Path) -> Listing {
    use crate::private_file::{read, Refused};
    match read(path, MAX_FILE, false) {
        Ok(None) => Listing::default(),
        Ok(Some(text)) => match parse(&text) {
            Ok(sites) => Listing {
                configured: true,
                error: None,
                sites,
            },
            Err(code) => Listing::refused(code),
        },
        Err(Refused::Custody) => Listing::refused("custody_rejected"),
        Err(Refused::TooLarge) => Listing::refused("too_large"),
        Err(Refused::Unreadable) => Listing::refused("unreadable"),
    }
}

fn site(entry: Entry) -> Option<Site> {
    if !slug_valid(&entry.slug) || !url_valid(&entry.url, &entry.slug) || entry.published_at_ms < 0
    {
        return None;
    }
    let kind = match entry.kind.as_str() {
        "static" => Kind::Static,
        "app" => Kind::App,
        _ => return None,
    };
    let status = match entry.status.as_str() {
        "live" => Status::Live,
        "disabled" => Status::Disabled,
        _ => return None,
    };
    let conversation_id = match entry.conversation_id {
        None => None,
        Some(id) => Some(conversation(&id)?),
    };
    let title = entry.title.unwrap_or_default();
    let title = match title.trim() {
        title if title.chars().any(char::is_control) => String::new(),
        title => title.chars().take(MAX_TITLE_CHARS).collect(),
    };
    let version = entry.version.filter(|v| {
        (1..=MAX_VERSION).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_graphic())
    });
    Some(Site {
        slug: entry.slug,
        title,
        url: entry.url,
        kind,
        conversation_id,
        published_at_ms: entry.published_at_ms,
        version,
        versions: entry.versions.unwrap_or(0),
        status,
    })
}

/// `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`
pub(crate) fn slug_valid(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    let edge = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    (1..=40).contains(&bytes.len())
        && bytes.first().is_some_and(edge)
        && bytes.last().is_some_and(edge)
        && bytes.iter().all(|b| edge(b) || *b == b'-')
}

/// `https://<slug>.<domain>[:port][/path]`: plain ASCII with nothing an
/// attribute could break on, no user info, and the slug's own host.
fn url_valid(url: &str, slug: &str) -> bool {
    https_host(url).is_some_and(|host| {
        host.strip_prefix(slug)
            .and_then(|parent| parent.strip_prefix('.'))
            .is_some_and(domain)
    })
}

/// The lowercased host of a plain `https://[host][:port][/path]` address:
/// ASCII with nothing an attribute could break on, at most 512 bytes, no
/// user info, and a port of 1 to 5 digits. The host itself is not checked.
/// Shared with the owner's app links (`app_links_http`).
pub(crate) fn https_host(url: &str) -> Option<String> {
    if url.len() > MAX_URL
        || url.bytes().any(|b| {
            !b.is_ascii_graphic() || matches!(b, b'"' | b'\'' | b'<' | b'>' | b'\\' | b'`')
        })
    {
        return None;
    }
    let rest = url.strip_prefix("https://")?;
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    if authority.contains('@') {
        return None;
    }
    let host = match authority.split_once(':') {
        None => authority,
        Some((host, port))
            if (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit()) =>
        {
            host
        }
        Some(_) => return None,
    };
    Some(host.to_ascii_lowercase())
}

/// Lowercase DNS labels of 1 to 63 letters, digits and inner hyphens.
pub(crate) fn domain(host: &str) -> bool {
    host.len() <= 253
        && host.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// A conversation id in its hyphenated form, lowercased.
fn conversation(id: &str) -> Option<String> {
    if id.len() != 36 {
        return None;
    }
    uuid::Uuid::parse_str(id)
        .ok()
        .map(|uuid| uuid.hyphenated().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const CHAT: &str = "00000000-0000-4000-8000-000000000001";

    fn entry(slug: &str, extra: Value) -> Value {
        let mut base = json!({"slug": slug, "title": "Synthetic site",
            "url": format!("https://{slug}.sites.example.com/"), "kind": "static",
            "conversation_id": CHAT, "published_at_ms": 1_000, "version": "v0001",
            "versions": 1, "status": "live"});
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }
    fn without(mut value: Value, key: &str) -> Value {
        value.as_object_mut().unwrap().remove(key);
        value
    }
    fn file(sites: Vec<Value>) -> String {
        json!({"format": FORMAT, "generated_at_ms": 2_000, "sites": sites}).to_string()
    }
    fn slugs(text: &str) -> Vec<String> {
        parse(text).unwrap().into_iter().map(|s| s.slug).collect()
    }

    #[test]
    fn the_contract_example_is_listed_newest_first() {
        let text = json!({"format": FORMAT, "generated_at_ms": 1_763_208_000_000_i64, "sites": [
            {"slug": "crm", "title": "CRM", "url": "https://crm.sites.example.com/", "kind": "app",
             "conversation_id": null, "published_at_ms": 1_763_100_000_000_i64, "version": null,
             "versions": 0, "status": "live"},
            {"slug": "notes", "title": "Team notes", "url": "https://notes.sites.example.com/",
             "kind": "static", "conversation_id": CHAT, "published_at_ms": 1_763_207_000_000_i64,
             "version": "v0003", "versions": 3, "status": "live", "surprise": {"ignored": true}}]})
        .to_string();
        let sites = parse(&text).unwrap();
        assert_eq!(slugs(&text), ["notes", "crm"]);
        assert_eq!(
            serde_json::to_value(&sites[0]).unwrap(),
            json!({"slug": "notes", "title": "Team notes", "url": "https://notes.sites.example.com/",
                "kind": "static", "conversation_id": CHAT, "published_at_ms": 1_763_207_000_000_i64,
                "version": "v0003", "versions": 3, "status": "live"})
        );
        assert_eq!(
            (
                sites[1].kind,
                sites[1].conversation_id.clone(),
                sites[1].version.clone()
            ),
            (Kind::App, None, None)
        );
    }

    #[test]
    fn entries_that_break_the_contract_are_dropped_one_by_one() {
        let text = file(vec![
            entry("ok", json!({})),
            entry("Bad", json!({"url": "https://bad.sites.example.com/"})),
            entry("-dash", json!({"url": "https://-dash.sites.example.com/"})),
            entry("dash-", json!({"url": "https://dash-.sites.example.com/"})),
            entry(&"a".repeat(41), json!({})),
            entry("plain", json!({"url": "http://plain.sites.example.com/"})),
            entry(
                "other",
                json!({"url": "https://elsewhere.sites.example.com/"}),
            ),
            entry(
                "prefix",
                json!({"url": "https://prefixed.sites.example.com/"}),
            ),
            entry("bare", json!({"url": "https://bare/"})),
            entry("user", json!({"url": "https://x@user.sites.example.com/"})),
            entry(
                "quote",
                json!({"url": "https://quote.sites.example.com/\"onload=x"}),
            ),
            entry(
                "space",
                json!({"url": "https://space.sites.example.com/a b"}),
            ),
            entry("port", json!({"url": "https://port.sites.example.com:x/"})),
            entry("kind", json!({"kind": "dynamic"})),
            entry("status", json!({"status": "deleted"})),
            entry("chat", json!({"conversation_id": "not-a-uuid"})),
            entry(
                "simple",
                json!({"conversation_id": "00000000000040008000000000000001"}),
            ),
            entry("negative", json!({"published_at_ms": -1})),
            without(entry("missing", json!({})), "published_at_ms"),
            without(entry("nameless", json!({})), "status"),
            entry("typed", json!({"versions": "three"})),
            json!("not an object"),
            entry("ok", json!({"title": "A duplicate"})),
            entry("last", json!({"published_at_ms": 500})),
        ]);
        assert_eq!(slugs(&text), ["ok", "last"]);
        assert_eq!(
            parse(&text).unwrap()[0].title,
            "Synthetic site",
            "the first of a slug wins"
        );
    }

    #[test]
    fn hosts_ports_titles_and_versions_are_normalised() {
        let id = "00000000-0000-4000-8000-00000000000A";
        let text = file(vec![
            entry(
                "a1",
                json!({"url": "https://A1.Sites.Example.com:8443/path?x=1#top", "conversation_id": id,
                "title": "  Spaced  ", "version": "has space", "status": "disabled"}),
            ),
            entry(
                "b2",
                json!({"title": "line\nbreak", "version": "", "published_at_ms": 2_000}),
            ),
            entry(
                "c3",
                json!({"title": null, "version": null, "versions": null, "published_at_ms": 3_000}),
            ),
            entry(
                "d4",
                json!({"title": "x".repeat(300), "published_at_ms": 4_000}),
            ),
        ]);
        let sites = parse(&text).unwrap();
        let by = |slug: &str| sites.iter().find(|s| s.slug == slug).unwrap();
        let a = by("a1");
        assert_eq!(
            (
                a.conversation_id.as_deref(),
                a.title.as_str(),
                a.version.clone(),
                a.status
            ),
            (
                Some("00000000-0000-4000-8000-00000000000a"),
                "Spaced",
                None,
                Status::Disabled
            )
        );
        assert_eq!(
            a.url, "https://A1.Sites.Example.com:8443/path?x=1#top",
            "kept as written"
        );
        assert_eq!(
            (by("b2").title.as_str(), by("b2").version.clone()),
            ("", None)
        );
        assert_eq!(by("d4").title.chars().count(), 200);
        let c = by("c3");
        assert_eq!(
            (c.title.as_str(), c.version.clone(), c.versions),
            ("", None, 0)
        );
        let bare = parse(&file(vec![without(
            without(entry("e5", json!({})), "title"),
            "versions",
        )]))
        .unwrap();
        assert_eq!((bare[0].title.as_str(), bare[0].versions), ("", 0));
    }

    #[test]
    fn a_file_that_cannot_be_used_gives_a_fixed_code() {
        assert_eq!(parse("not json"), Err("invalid_json"));
        assert_eq!(
            parse(r#"{"format": "other", "generated_at_ms": 0}"#),
            Err("unknown_format")
        );
        assert_eq!(
            parse(&json!({"format": FORMAT}).to_string()),
            Err("invalid_json")
        );
        assert_eq!(
            parse(&json!({"format": FORMAT, "generated_at_ms": 0}).to_string()),
            Ok(vec![])
        );
        let many: Vec<Value> = (0..=MAX_SITES)
            .map(|n| entry(&format!("s{n}"), json!({})))
            .collect();
        assert_eq!(parse(&file(many)), Err("too_many_sites"));
        let most: Vec<Value> = (0..MAX_SITES)
            .map(|n| entry(&format!("s{n}"), json!({})))
            .collect();
        assert_eq!(parse(&file(most)).unwrap().len(), MAX_SITES);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_read_only_with_its_custody_checked() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("sites-catalog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("sites-catalog.json");
        assert_eq!(load(&path), Listing::default(), "no file: not configured");
        std::fs::write(&path, file(vec![entry("notes", json!({}))])).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let listing = load(&path);
        assert_eq!(
            (listing.configured, listing.error, listing.sites.len()),
            (true, None, 1)
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(load(&path), Listing::refused("custody_rejected"));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert_eq!(load(&link), Listing::refused("unreadable"));
        let hard = dir.join("hard.json");
        std::fs::hard_link(&path, &hard).unwrap();
        assert_eq!(load(&path), Listing::refused("custody_rejected"));
        std::fs::remove_file(&hard).unwrap();
        std::fs::write(&path, " ".repeat(MAX_FILE + 1)).unwrap();
        assert_eq!(load(&path), Listing::refused("too_large"));
        std::fs::write(&path, "{").unwrap();
        assert_eq!(load(&path), Listing::refused("invalid_json"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
