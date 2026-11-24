//! The host's list of the owner's tools and apps (`docs/v2/app-links.md`).
//!
//! The operator keeps one small file next to the sites catalog and edits it
//! by hand or with a deployment tool, writing it atomically:
//!
//! ```json
//! {"format": "orkestr-app-links-v1",
//!  "links": [{"id": "vault", "title": "Vault (passwords)",
//!             "url": "https://vault.example.com/ui/", "group": "Tools",
//!             "description": "Passwords, tokens and API keys.",
//!             "hint": "Sign in with OIDC (your Orkestr login)"}]}
//! ```
//!
//! It names addresses, never a secret, and the server never fetches one.
//! The order of the file is the order of the page. An entry that breaks the
//! contract is dropped on its own; a file that cannot be used at all gives an
//! empty list and a fixed code.
use crate::sites_http::catalog::{domain, https_host, slug_valid};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub(crate) const FORMAT: &str = "orkestr-app-links-v1";
pub(crate) const MAX_FILE: usize = 256 * 1024;
pub(crate) const MAX_LINKS: usize = 200;
const MAX_TITLE_CHARS: usize = 80;
const MAX_GROUP_CHARS: usize = 40;
const MAX_TEXT_CHARS: usize = 200;
/// The group of a link that names none.
pub(crate) const DEFAULT_GROUP: &str = "Apps";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Link {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) group: String,
    pub(crate) description: Option<String>,
    /// One line on how to get in, for example which sign-in to use.
    pub(crate) hint: Option<String>,
}

/// What `GET /api/v2/app-links` answers.
#[derive(Debug, Default, PartialEq, Serialize)]
pub(crate) struct Listing {
    /// A links file exists (even one that was refused).
    pub(crate) configured: bool,
    /// Why the file was not used: a fixed code, never its content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<&'static str>,
    pub(crate) links: Vec<Link>,
}

impl Listing {
    pub(crate) fn refused(code: &'static str) -> Self {
        Listing {
            configured: true,
            error: Some(code),
            links: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
struct File {
    format: String,
    #[serde(default)]
    links: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct Entry {
    id: String,
    title: String,
    url: String,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    hint: Option<String>,
}

/// The file's text to its links, in the file's order.
pub(crate) fn parse(text: &str) -> Result<Vec<Link>, &'static str> {
    let file = serde_json::from_str::<File>(text).map_err(|_| "invalid_json")?;
    if file.format != FORMAT {
        return Err("unknown_format");
    }
    if file.links.len() > MAX_LINKS {
        return Err("too_many_links");
    }
    let mut links: Vec<Link> = Vec::new();
    for value in file.links {
        let Some(link) = serde_json::from_value::<Entry>(value).ok().and_then(link) else {
            continue;
        };
        if !links.iter().any(|l| l.id == link.id) {
            links.push(link);
        }
    }
    Ok(links)
}

/// Reads the file with its custody checked like the sites catalog: root or
/// this server's user, no writes by group or others, one link, a regular file.
pub(crate) fn load(path: &Path) -> Listing {
    use crate::private_file::{read, Refused};
    match read(path, MAX_FILE, false) {
        Ok(None) => Listing::default(),
        Ok(Some(text)) => match parse(&text) {
            Ok(links) => Listing {
                configured: true,
                error: None,
                links,
            },
            Err(code) => Listing::refused(code),
        },
        Err(Refused::Custody) => Listing::refused("custody_rejected"),
        Err(Refused::TooLarge) => Listing::refused("too_large"),
        Err(Refused::Unreadable) => Listing::refused("unreadable"),
    }
}

fn link(entry: Entry) -> Option<Link> {
    if !slug_valid(&entry.id) || !https_host(&entry.url).is_some_and(|host| named(&host)) {
        return None;
    }
    Some(Link {
        title: text(Some(entry.title), MAX_TITLE_CHARS)?,
        id: entry.id,
        url: entry.url,
        group: text(entry.group, MAX_GROUP_CHARS).unwrap_or_else(|| DEFAULT_GROUP.to_owned()),
        description: text(entry.description, MAX_TEXT_CHARS),
        hint: text(entry.hint, MAX_TEXT_CHARS),
    })
}

/// A host name with a parent domain, not a bare name or an IP address: the
/// owner's browser opens it from anywhere.
fn named(host: &str) -> bool {
    domain(host)
        && host.contains('.')
        && host
            .rsplit('.')
            .next()
            .is_some_and(|top| top.bytes().any(|b| b.is_ascii_lowercase()))
}

/// Trimmed and cut to `max` characters; empty, or with a control character
/// (a line break included): none.
fn text(value: Option<String>, max: usize) -> Option<String> {
    let value = value?;
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.chars().take(max).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn entry(id: &str, extra: Value) -> Value {
        let mut base = json!({"id": id, "title": "Synthetic tool",
            "url": format!("https://{id}.apps.example.com/"), "group": "Tools",
            "description": "A synthetic tool.", "hint": "Sign in there."});
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }
    fn without(mut value: Value, key: &str) -> Value {
        value.as_object_mut().unwrap().remove(key);
        value
    }
    fn file(links: Vec<Value>) -> String {
        json!({"format": FORMAT, "links": links}).to_string()
    }
    fn ids(text: &str) -> Vec<String> {
        parse(text).unwrap().into_iter().map(|l| l.id).collect()
    }

    #[test]
    fn the_contract_example_is_listed_in_the_files_order() {
        let text = json!({"format": FORMAT, "links": [
            {"id": "vault", "title": "Vault (passwords)", "url": "https://vault.example.com/ui/",
             "group": "Tools", "description": "Passwords, tokens and API keys.",
             "hint": "Sign in with OIDC (your Orkestr login)", "surprise": {"ignored": true}},
            {"id": "crm", "title": "CRM", "url": "https://crm.example.org/"}]})
        .to_string();
        let links = parse(&text).unwrap();
        assert_eq!(ids(&text), ["vault", "crm"], "the file's order, not sorted");
        assert_eq!(
            serde_json::to_value(&links[0]).unwrap(),
            json!({"id": "vault", "title": "Vault (passwords)", "url": "https://vault.example.com/ui/",
                "group": "Tools", "description": "Passwords, tokens and API keys.",
                "hint": "Sign in with OIDC (your Orkestr login)"})
        );
        assert_eq!(
            serde_json::to_value(&links[1]).unwrap(),
            json!({"id": "crm", "title": "CRM", "url": "https://crm.example.org/",
                "group": DEFAULT_GROUP, "description": null, "hint": null}),
            "no group: the default one; no description or hint: null"
        );
    }

    #[test]
    fn entries_that_break_the_contract_are_dropped_one_by_one() {
        let text = file(vec![
            entry("ok", json!({})),
            entry("Bad", json!({})),
            entry("-dash", json!({})),
            entry(&"a".repeat(41), json!({})),
            entry("plain", json!({"url": "http://plain.apps.example.com/"})),
            entry("bare", json!({"url": "https://bare/"})),
            entry("ip", json!({"url": "https://127.0.0.1:8200/ui/"})),
            entry("user", json!({"url": "https://x@user.apps.example.com/"})),
            entry(
                "quote",
                json!({"url": "https://quote.apps.example.com/\"onload=x"}),
            ),
            entry(
                "space",
                json!({"url": "https://space.apps.example.com/a b"}),
            ),
            entry("port", json!({"url": "https://port.apps.example.com:x/"})),
            entry("label", json!({"url": "https://-x.apps.example.com/"})),
            entry("script", json!({"url": "javascript:alert(1)"})),
            entry(
                "long",
                json!({"url": format!("https://long.example.com/{}", "a".repeat(600))}),
            ),
            entry("untitled", json!({"title": "  "})),
            entry("broken", json!({"title": "line\nbreak"})),
            without(entry("nameless", json!({})), "title"),
            without(entry("nowhere", json!({})), "url"),
            entry("typed", json!({"title": 3})),
            json!("not an object"),
            entry("ok", json!({"title": "A duplicate"})),
            entry("last", json!({})),
        ]);
        assert_eq!(ids(&text), ["ok", "last"]);
        assert_eq!(
            parse(&text).unwrap()[0].title,
            "Synthetic tool",
            "the first of an id wins"
        );
    }

    #[test]
    fn texts_hosts_and_groups_are_normalised() {
        let text = file(vec![
            entry(
                "a1",
                json!({"url": "https://A1.Apps.Example.com:8443/path?x=1#top", "title": "  Spaced  ",
                "group": " Ops ", "description": "two\nlines", "hint": ""}),
            ),
            entry(
                "b2",
                json!({"title": "x".repeat(300), "group": "g".repeat(60),
                "description": "d".repeat(500), "hint": null}),
            ),
            entry("c3", json!({"group": "", "description": null})),
            without(
                without(without(entry("d4", json!({})), "group"), "description"),
                "hint",
            ),
            entry("e5", json!({"group": "tab\there"})),
        ]);
        let links = parse(&text).unwrap();
        let by = |id: &str| links.iter().find(|l| l.id == id).unwrap();
        let a = by("a1");
        assert_eq!(
            (
                a.title.as_str(),
                a.group.as_str(),
                a.description.clone(),
                a.hint.clone()
            ),
            ("Spaced", "Ops", None, None)
        );
        assert_eq!(
            a.url, "https://A1.Apps.Example.com:8443/path?x=1#top",
            "kept as written"
        );
        let b = by("b2");
        assert_eq!(b.title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(b.group.chars().count(), MAX_GROUP_CHARS);
        assert_eq!(b.description.as_ref().unwrap().chars().count(), 200);
        assert_eq!(b.hint, None);
        for id in ["c3", "d4", "e5"] {
            assert_eq!(by(id).group, DEFAULT_GROUP, "{id}");
        }
        assert_eq!(
            (by("d4").description.clone(), by("d4").hint.clone()),
            (None, None)
        );
    }

    #[test]
    fn a_file_that_cannot_be_used_gives_a_fixed_code() {
        assert_eq!(parse("not json"), Err("invalid_json"));
        assert_eq!(parse(r#"{"format": "other"}"#), Err("unknown_format"));
        assert_eq!(parse(r#"{"links": []}"#), Err("invalid_json"));
        assert_eq!(parse(&json!({"format": FORMAT}).to_string()), Ok(vec![]));
        let many: Vec<Value> = (0..=MAX_LINKS)
            .map(|n| entry(&format!("l{n}"), json!({})))
            .collect();
        assert_eq!(parse(&file(many)), Err("too_many_links"));
        let most: Vec<Value> = (0..MAX_LINKS)
            .map(|n| entry(&format!("l{n}"), json!({})))
            .collect();
        assert_eq!(parse(&file(most)).unwrap().len(), MAX_LINKS);
    }

    #[cfg(unix)]
    #[test]
    fn the_links_file_is_read_only_with_its_custody_checked() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("app-links-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("app-links.json");
        assert_eq!(load(&path), Listing::default(), "no file: not configured");
        std::fs::write(&path, file(vec![entry("vault", json!({}))])).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let listing = load(&path);
        assert_eq!(
            (listing.configured, listing.error, listing.links.len()),
            (true, None, 1)
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(load(&path).links.len(), 1, "readable by others is fine");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o664)).unwrap();
        assert_eq!(load(&path), Listing::refused("custody_rejected"));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert_eq!(load(&link), Listing::refused("unreadable"));
        std::fs::write(&path, " ".repeat(MAX_FILE + 1)).unwrap();
        assert_eq!(load(&path), Listing::refused("too_large"));
        std::fs::write(&path, "{").unwrap();
        assert_eq!(load(&path), Listing::refused("invalid_json"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
