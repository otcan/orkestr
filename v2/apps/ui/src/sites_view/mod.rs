//! Sites (`#sites`, ORK-834): the static sites and apps the owner's chats
//! published, one row per site with its chat, kind, last publish and an Open
//! link. A chat with a live site also gets a Site link in its header
//! (`header`). Both read one shared list, refreshed every minute while the
//! workspace is open and whenever this page opens.
use dioxus::prelude::*;
use orkestr_v2_contracts::SidebarPage;
use orkestr_v2_ui::credentials::{self, ChatNames};
use orkestr_v2_ui::session_scope::SessionScope;
use orkestr_v2_ui::sites::{self, Catalog, Site};
use serde_json::Value;

mod header;
pub use header::HeaderSiteLink;

/// A publish shows up in the chat header within this long.
const POLL_MS: u32 = 60_000;

/// The list shared by the chat header and the Sites page; bump `refresh`
/// to read it again now.
#[derive(Clone, Copy, PartialEq)]
pub struct SitesCatalog {
    pub catalog: Signal<Catalog>,
    pub refresh: Signal<u64>,
}

/// Reads `/api/v2/sites` for the workspace: at once, every minute (not for
/// an older server without the route, nor a session it refuses) and on each
/// `refresh`. A failure never signs the owner out: a service session may
/// use the app without seeing sites.
pub fn use_sites_catalog(session_scope: Signal<SessionScope>) -> SitesCatalog {
    let mut catalog = use_signal(Catalog::default);
    let refresh = use_signal(|| 0_u64);
    let mut tick = use_signal(|| 0_u64);
    let mut asked = use_signal(|| 0_u64);
    use_future(move || async move {
        loop {
            crate::transport::sleep(POLL_MS).await;
            tick += 1;
        }
    });
    use_resource(move || async move {
        let wanted = refresh();
        let _ = tick();
        let explicit = wanted != *asked.peek();
        asked.set(wanted);
        if !explicit && !catalog.peek().polls() {
            return;
        }
        let generation = session_scope.peek().generation();
        let result =
            crate::transport::request::<sites::Page>("GET", "/api/v2/sites", Value::Null, "", "")
                .await
                .map_err(|e| (e.status, e.message));
        if !session_scope.peek().is_current(generation) {
            return;
        }
        let next = Catalog::from_answer(result);
        if *catalog.peek() != next {
            catalog.set(next);
        }
    });
    SitesCatalog { catalog, refresh }
}

#[component]
pub fn Sites(sites: SitesCatalog, session_scope: Signal<SessionScope>) -> Element {
    let mut names = use_signal(ChatNames::default);
    let mut now = use_signal(|| 0_i64);
    use_future(move || async move {
        let mut refresh = sites.refresh;
        refresh += 1;
        let generation = session_scope.peek().generation();
        let sidebar = crate::transport::request::<SidebarPage>(
            "GET",
            "/api/v2/sidebar?include_hidden=true",
            Value::Null,
            "",
            "",
        )
        .await;
        let clock = crate::timer_bridge::now_ms().await;
        if !session_scope.peek().is_current(generation) {
            return;
        }
        now.set(clock);
        if let Ok(sidebar) = sidebar {
            names.set(ChatNames::from_sidebar(&sidebar.entries));
        }
    });
    // `(text, retry)`: what to say instead of the list, and whether asking
    // again may help.
    let status = match (sites.catalog)() {
        Catalog::Ready(page) => Ok(page),
        Catalog::Loading => Err(("Loading sites…".to_owned(), false)),
        Catalog::Unsupported => Err(("This server has no sites page yet.".to_owned(), false)),
        Catalog::Failed { status: 401, .. } => Err((
            "Sites need a session signed in with your password. Sign in again.".to_owned(),
            false,
        )),
        Catalog::Failed { message, .. } => {
            Err((format!("Sites could not be loaded. {message}"), true))
        }
    };
    let page = match status {
        Ok(page) => page,
        Err((text, retry)) => {
            return rsx! {
                section { class: "sites-page", "aria-label": "Sites",
                    style { "{include_str!(\"../sites.css\")}" }
                    p { class: "sites-intro", role: "status", "{text}" }
                    if retry {
                        button { r#type: "button", class: "sites-retry", onclick: move |_| {
                            let mut refresh = sites.refresh;
                            refresh += 1;
                        }, "Try again" }
                    }
                }
            }
        }
    };
    let chat_names = names();
    let total = page.sites.len();
    let counted = match total {
        1 => "1 site".to_owned(),
        n => format!("{n} sites"),
    };
    rsx! {
        section { class: "sites-page", "aria-label": "Sites",
            style { "{include_str!(\"../sites.css\")}" }
            p { class: "sites-intro",
                "Web pages and apps your chats published. Each opens in a new tab at its own address; a chat with a live site also links it in its header."
            }
            if let Some(code) = page.error.as_deref() {
                p { class: "sites-notice", role: "status", "{sites::error_text(code)}" }
            }
            if total == 0 {
                p { class: "sites-empty",
                    "No sites yet. A chat publishes a folder as a site with "
                    code { "orkestr-site publish <folder>" }
                    "; it then appears here and as a Site link in that chat's header."
                }
            } else {
                p { class: "sites-count", "{counted}" }
                div { class: "sites-table-wrap",
                    table { class: "sites-table",
                        thead { tr {
                            th { scope: "col", "Site" }
                            th { scope: "col", "Chat" }
                            th { scope: "col", "Kind" }
                            th { scope: "col", "Last published" }
                            th { scope: "col", "Version" }
                            th { scope: "col", span { class: "visually-hidden", "Open" } }
                        } }
                        tbody {
                            for site in page.sites.iter() {
                                SiteRow { key: "{site.slug}", site: site.clone(), chat: sites::chat_label(site, &chat_names), now: now() }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// One site. Each cell names its column (`data-label`), so a phone shows a card.
#[component]
fn SiteRow(site: Site, chat: String, now: i64) -> Element {
    let when = if now > 0 {
        credentials::ago(now, site.published_at_ms)
    } else {
        credentials::absolute_time(site.published_at_ms)
    };
    let exact = credentials::absolute_time(site.published_at_ms);
    let kind = sites::kind_label(&site.kind);
    let version = sites::version_label(&site);
    let link = site.link().map(str::to_owned);
    let no_chat = site.conversation_id.is_none();
    rsx! {
        tr { class: "site-row", "data-site": "{site.slug}", "data-status": "{site.status}",
            td { "data-label": "Site", class: "site-name",
                strong { "{site.name()}" }
                span { class: "site-address", "{site.address()}" }
            }
            td { "data-label": "Chat", class: if no_chat { "site-chat site-none" } else { "site-chat" }, "{chat}" }
            td { "data-label": "Kind", span { class: "site-kind", "data-kind": "{site.kind}", "{kind}" } }
            td { "data-label": "Last published", class: "site-published",
                time { title: "{exact}", "{when}" }
            }
            td { "data-label": "Version", class: "site-version", "{version}" }
            td { "data-label": "Open", class: "site-open",
                if let Some(url) = link {
                    a { class: "site-open-link", href: "{url}", target: "_blank", rel: "noopener noreferrer",
                        title: "Open {site.name()} in a new tab", "Open" }
                } else {
                    span { class: "site-disabled", "Disabled" }
                }
            }
        }
    }
}
