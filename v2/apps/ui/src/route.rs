//! Deep-linkable locations. Every workspace view has a URL fragment, so
//! reload keeps the view and back/forward move between views:
//!
//! - `#conversation/<id>` (chat) or `#conversation/<id>/<tab>`
//! - `#v1/<thread>`: a linked V1 chat
//! - `#host` (overview) and `#host/details?range=15m|1h|24h|7d`
use orkestr_v2_contracts::HostMetricsRange;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Chat,
    Work,
    History,
    Projects,
    Timers,
    Tracker,
    Memory,
    LiveMap,
    Host,
    Settings,
}

impl Tab {
    pub const ALL: [Tab; 10] = [
        Tab::Chat,
        Tab::Work,
        Tab::History,
        Tab::Projects,
        Tab::Timers,
        Tab::Tracker,
        Tab::Memory,
        Tab::LiveMap,
        Tab::Host,
        Tab::Settings,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Tab::Chat => "Chat",
            Tab::Work => "Work",
            Tab::History => "History",
            Tab::Projects => "Projects",
            Tab::Timers => "Timers",
            Tab::Tracker => "Tracker",
            Tab::Memory => "Memory",
            Tab::LiveMap => "Live map",
            Tab::Host => "Host resources",
            Tab::Settings => "Settings",
        }
    }
    pub fn slug(self) -> &'static str {
        match self {
            Tab::Chat => "chat",
            Tab::Work => "work",
            Tab::History => "history",
            Tab::Projects => "projects",
            Tab::Timers => "timers",
            Tab::Tracker => "tracker",
            Tab::Memory => "memory",
            Tab::LiveMap => "live-map",
            Tab::Host => "host",
            Tab::Settings => "settings",
        }
    }
    pub fn from_label(label: &str) -> Option<Tab> {
        Tab::ALL.into_iter().find(|t| t.label() == label)
    }
    fn from_slug(slug: &str) -> Option<Tab> {
        Tab::ALL
            .into_iter()
            .find(|t| t.slug() == slug && *t != Tab::Host)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
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
