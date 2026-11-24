//! Sites (ORK-834): what `/api/v2/sites` answers, the chat header's Site link
//! and the Sites page's wording. The host's catalog names each published site;
//! nothing here fetches a site.
use crate::credentials::ChatNames;
use serde::Deserialize;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Page {
    /// The host has a catalog file (even one it refused).
    #[serde(default)]
    pub configured: bool,
    /// Why the catalog was not used: a fixed code.
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub sites: Vec<Site>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Site {
    pub slug: String,
    #[serde(default)]
    pub title: String,
    pub url: String,
    /// `static` or `app`.
    pub kind: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    pub published_at_ms: i64,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub versions: u32,
    /// `live` or `disabled`.
    pub status: String,
}

impl Site {
    /// Its title, or its slug when it has none.
    pub fn name(&self) -> &str {
        match self.title.trim() {
            "" => &self.slug,
            title => title,
        }
    }
    pub fn live(&self) -> bool {
        self.status == "live"
    }
    /// The address an Open link may use: a live site's own `https://`
    /// address, plain enough for an attribute. Disabled sites have none.
    pub fn link(&self) -> Option<&str> {
        (self.live() && plain_https(&self.url)).then_some(self.url.as_str())
    }
    /// The address without its scheme and trailing slash, for a second line.
    pub fn address(&self) -> &str {
        let rest = self.url.strip_prefix("https://").unwrap_or(&self.url);
        rest.strip_suffix('/').unwrap_or(rest)
    }
    pub fn belongs_to(&self, conversation: &str) -> bool {
        self.conversation_id
            .as_deref()
            .is_some_and(|id| id.eq_ignore_ascii_case(conversation))
    }
}

/// An `https://` address of at most 512 bytes, plain enough for an
/// attribute: visible ASCII without quotes, `<`, `>`, `\` or backticks.
/// Shared with the Apps page's links (`app_links`).
pub fn plain_https(url: &str) -> bool {
    url.len() <= 512
        && url.starts_with("https://")
        && url.bytes().all(|b| {
            b.is_ascii_graphic() && !matches!(b, b'"' | b'\'' | b'<' | b'>' | b'\\' | b'`')
        })
}

pub fn kind_label(kind: &str) -> &'static str {
    match kind {
        "static" => "Static site",
        "app" => "App",
        _ => "Site",
    }
}

/// The chat column: the chat's name, "No chat" for a site no chat published,
/// or a plain stand-in for a chat this list does not show.
pub fn chat_label(site: &Site, names: &ChatNames) -> String {
    match site.conversation_id.as_deref() {
        None => "No chat".into(),
        Some(id) => names.label(id),
    }
}

/// `v0003 · 3 versions`, `v0001`, or `—` when the catalog names none.
pub fn version_label(site: &Site) -> String {
    let count = match site.versions {
        0 | 1 => None,
        n => Some(format!("{n} versions")),
    };
    match (site.version.as_deref(), count) {
        (Some(version), Some(count)) => format!("{version} · {count}"),
        (Some(version), None) => version.to_owned(),
        (None, Some(count)) => count,
        (None, None) => "—".into(),
    }
}

/// Plain words for the catalog's refusal codes.
pub fn error_text(code: &str) -> String {
    let why = match code {
        "custody_rejected" => "its file is not protected the way it must be",
        "too_large" | "too_many_sites" => "it is larger than this server reads",
        "invalid_json" | "unknown_format" => "it is not in the expected format",
        _ => "it could not be read",
    };
    format!("The server's list of published sites was not used: {why}. No site is shown until the host writes it again.")
}

/// What the chat header links for one conversation: its newest live site,
/// and how many other sites (live or not) that chat has on the Sites page.
#[derive(Debug, Clone, PartialEq)]
pub struct HeaderLink {
    pub url: String,
    pub name: String,
    pub others: usize,
}

pub fn header_link(page: &Page, conversation: &str) -> Option<HeaderLink> {
    if conversation.is_empty() {
        return None;
    }
    let mine: Vec<&Site> = page
        .sites
        .iter()
        .filter(|s| s.belongs_to(conversation))
        .collect();
    let newest = mine.iter().filter(|s| s.link().is_some()).max_by(|a, b| {
        a.published_at_ms
            .cmp(&b.published_at_ms)
            .then_with(|| b.slug.cmp(&a.slug))
    })?;
    Some(HeaderLink {
        url: newest.url.clone(),
        name: newest.name().to_owned(),
        others: mine.len() - 1,
    })
}

/// The shared state of the sites list: the chat header and the Sites page
/// read the same answer.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum Catalog {
    #[default]
    Loading,
    Ready(Page),
    /// An older server without `/api/v2/sites`.
    Unsupported,
    Failed {
        status: u16,
        message: String,
    },
}

impl Catalog {
    /// A failed or missing list never shows a header link.
    pub fn header_link(&self, conversation: &str) -> Option<HeaderLink> {
        match self {
            Catalog::Ready(page) => header_link(page, conversation),
            _ => None,
        }
    }
    /// Whether a periodic refresh is worth a request: not for a server
    /// without the route or a session the route refuses.
    pub fn polls(&self) -> bool {
        !matches!(
            self,
            Catalog::Unsupported | Catalog::Failed { status: 401, .. }
        )
    }
    /// A request's outcome as the shared state.
    pub fn from_answer(result: Result<Page, (u16, String)>) -> Catalog {
        match result {
            Ok(page) => Catalog::Ready(page),
            Err((404, _)) => Catalog::Unsupported,
            Err((status, message)) => Catalog::Failed { status, message },
        }
    }
}
