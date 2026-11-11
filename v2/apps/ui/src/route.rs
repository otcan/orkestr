//! Deep-linkable locations. Every workspace view has a URL fragment, so
//! reload keeps the view and back/forward move between views:
//!
//! - `#conversation/<id>` (chat) or `#conversation/<id>/<tab>`
//! - `#v1/<thread>`: a linked V1 chat
//! - `#host` (overview) and `#host/details?range=15m|1h|24h|7d`
//! - `/virtual-desks`: owner-wide desks (old `#conversation/<id>/virtual-desks`
//!   links open it too)
//! - `#settings`: Orkestr settings, owned by the account and this server
//!   (password, vault, provider sign-in, installation). A conversation's own
//!   settings stay at `#conversation/<id>/settings` (ORK-789).
//!
//! Navigation groups (ORK-786): a conversation shows [`Tab::PRIMARY`] and
//! keeps the rest under "More" ([`Tab::MORE`]); [`Tab::GLOBAL`] views belong
//! to the app header and never take a conversation's scope.
use orkestr_v2_contracts::HostMetricsRange;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Chat,
    Work,
    Files,
    History,
    Projects,
    Timers,
    Tracker,
    Memory,
    LiveMap,
    VirtualDesks,
    Host,
    Settings,
    OrkestrSettings,
}

impl Tab {
    pub const ALL: [Tab; 13] = [
        Tab::Chat,
        Tab::Work,
        Tab::Files,
        Tab::History,
        Tab::Projects,
        Tab::Timers,
        Tab::Tracker,
        Tab::Memory,
        Tab::LiveMap,
        Tab::VirtualDesks,
        Tab::Host,
        Tab::Settings,
        Tab::OrkestrSettings,
    ];
    /// Always visible in a conversation's heading.
    pub const PRIMARY: [Tab; 3] = [Tab::Chat, Tab::Work, Tab::Files];
    /// A conversation's other destinations, listed under "More".
    pub const MORE: [Tab; 7] = [
        Tab::History,
        Tab::Projects,
        Tab::Timers,
        Tab::Tracker,
        Tab::Memory,
        Tab::LiveMap,
        Tab::Settings,
    ];
    /// Owner-wide views, opened from the app header.
    pub const GLOBAL: [Tab; 3] = [Tab::VirtualDesks, Tab::Host, Tab::OrkestrSettings];

    /// An owner-wide view: its route carries no conversation.
    pub fn is_global(self) -> bool {
        Tab::GLOBAL.contains(&self)
    }
    pub fn in_more(self) -> bool {
        Tab::MORE.contains(&self)
    }
    pub fn label(self) -> &'static str {
        match self {
            Tab::Chat => "Chat",
            Tab::Work => "Work",
            Tab::Files => "Files",
            Tab::History => "History",
            Tab::Projects => "Projects",
            Tab::Timers => "Timers",
            Tab::Tracker => "Job tracker",
            Tab::Memory => "Memory",
            Tab::LiveMap => "Live map",
            Tab::VirtualDesks => "Virtual desks",
            Tab::Host => "Host resources",
            Tab::Settings => "Chat settings",
            Tab::OrkestrSettings => "Orkestr settings",
        }
    }
    pub fn slug(self) -> &'static str {
        match self {
            Tab::Chat => "chat",
            Tab::Work => "work",
            Tab::Files => "files",
            Tab::History => "history",
            Tab::Projects => "projects",
            Tab::Timers => "timers",
            Tab::Tracker => "tracker",
            Tab::Memory => "memory",
            Tab::LiveMap => "live-map",
            Tab::VirtualDesks => "virtual-desks",
            Tab::Host => "host",
            Tab::Settings => "settings",
            Tab::OrkestrSettings => "orkestr-settings",
        }
    }
    pub fn from_label(label: &str) -> Option<Tab> {
        Tab::ALL.into_iter().find(|t| t.label() == label)
    }
    fn from_slug(slug: &str) -> Option<Tab> {
        Tab::ALL
            .into_iter()
            .find(|t| t.slug() == slug && !t.is_global())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    VirtualDesks,
    OrkestrSettings,
    Conversation {
        id: String,
        tab: Tab,
    },
    V1Thread {
        thread: String,
    },
    Host {
        charts: bool,
        range: HostMetricsRange,
    },
}

fn uuid(value: &str) -> Option<String> {
    let ok = value.len() == 36
        && value.char_indices().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
        && value != "00000000-0000-0000-0000-000000000000";
    ok.then(|| value.to_ascii_lowercase())
}

fn thread(value: &str) -> Option<String> {
    ((1..=200).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        && value != "."
        && value != "..")
        .then(|| value.to_owned())
}

impl Route {
    pub fn parse(hash: &str) -> Option<Route> {
        let rest = hash.strip_prefix('#').unwrap_or(hash);
        let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
        let parts: Vec<&str> = path.split('/').collect();
        match parts.as_slice() {
            ["conversation", id] => Some(Route::Conversation {
                id: uuid(id)?,
                tab: Tab::Chat,
            }),
            ["conversation", id, "virtual-desks"] => {
                uuid(id)?;
                Some(Route::VirtualDesks)
            }
            ["virtual-desks"] | ["", "virtual-desks"] | ["", "virtual-desks", ""] => {
                Some(Route::VirtualDesks)
            }
            ["settings"] => Some(Route::OrkestrSettings),
            ["conversation", id, slug] => Some(Route::Conversation {
                id: uuid(id)?,
                tab: Tab::from_slug(slug)?,
            }),
            ["v1", id] => Some(Route::V1Thread {
                thread: thread(id)?,
            }),
            ["host"] | ["host", "details"] => {
                let range = query
                    .split('&')
                    .find_map(|p| p.strip_prefix("range="))
                    .map(HostMetricsRange::parse);
                Some(Route::Host {
                    charts: parts.len() == 2,
                    range: match range {
                        None => HostMetricsRange::Hour1,
                        Some(found) => found?,
                    },
                })
            }
            _ => None,
        }
    }

    pub fn hash(&self) -> String {
        match self {
            Route::VirtualDesks => "/virtual-desks".into(),
            Route::OrkestrSettings => "#settings".into(),
            Route::Conversation { id, tab: Tab::Chat } => format!("#conversation/{id}"),
            Route::Conversation { id, tab } => format!("#conversation/{id}/{}", tab.slug()),
            Route::V1Thread { thread } => format!("#v1/{thread}"),
            Route::Host { charts: false, .. } => "#host".into(),
            Route::Host {
                charts: true,
                range,
            } => format!("#host/details?range={}", range.label()),
        }
    }
}
