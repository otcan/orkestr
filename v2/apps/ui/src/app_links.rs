//! The Apps page (`#apps`): the owner's tools and apps that the host lists
//! (`/api/v2/app-links`, `docs/v2/app-links.md`), grouped as the host lists
//! them, and the live sites his chats published (ORK-834). Nothing here
//! fetches a link: every one opens in a new tab.
use crate::sites::{self, plain_https, Site};
use serde::Deserialize;

/// The heading of a link the host put in no group.
pub const DEFAULT_GROUP: &str = "Apps";

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Page {
    /// The host has a links file (even one it refused).
    #[serde(default)]
    pub configured: bool,
    /// Why the file was not used: a fixed code.
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Link {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub description: Option<String>,
    /// One line on how to get in, for example which sign-in to use.
    #[serde(default)]
    pub hint: Option<String>,
}

impl Link {
    /// The address an Open link may use: its own `https://` address, plain
    /// enough for an attribute; none for anything else.
    pub fn link(&self) -> Option<&str> {
        plain_https(&self.url).then_some(self.url.as_str())
    }
    /// The address without its scheme and trailing slash, for a second line.
    pub fn address(&self) -> &str {
        let rest = self.url.strip_prefix("https://").unwrap_or(&self.url);
        rest.strip_suffix('/').unwrap_or(rest)
    }
}

/// One heading of the page and its links, in the host's order.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub name: String,
    pub links: Vec<Link>,
}

/// The host's links by group: each group where its first link is, the links
/// in the host's order. A link without a usable address is left out.
pub fn groups(page: &Page) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    for link in page.links.iter().filter(|l| l.link().is_some()) {
        let name = match link.group.trim() {
            "" => DEFAULT_GROUP,
            name => name,
        };
        match groups.iter_mut().find(|g| g.name == name) {
            Some(group) => group.links.push(link.clone()),
            None => groups.push(Group {
                name: name.to_owned(),
                links: vec![link.clone()],
            }),
        }
    }
    groups
}

/// The published sites the page links: live ones with an address, in the
/// server's order (newest publish first).
pub fn live_sites(page: &sites::Page) -> Vec<Site> {
    page.sites
        .iter()
        .filter(|s| s.link().is_some())
        .cloned()
        .collect()
}

/// Plain words for the links file's refusal codes.
pub fn error_text(code: &str) -> String {
    let why = match code {
        "custody_rejected" => "its file is not protected the way it must be",
        "too_large" | "too_many_links" => "it is larger than this server reads",
        "invalid_json" | "unknown_format" => "it is not in the expected format",
        _ => "it could not be read",
    };
    format!("The server's list of tools and apps was not used: {why}. Your published sites are still listed below.")
}

/// The state of the links read.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum Links {
    #[default]
    Loading,
    Ready(Page),
    /// An older server without `/api/v2/app-links`.
    Unsupported,
    Failed {
        status: u16,
        message: String,
    },
}

impl Links {
    /// A request's outcome as the page's state.
    pub fn from_answer(result: Result<Page, (u16, String)>) -> Links {
        match result {
            Ok(page) => Links::Ready(page),
            Err((404, _)) => Links::Unsupported,
            Err((status, message)) => Links::Failed { status, message },
        }
    }
}
