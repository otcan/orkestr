//! Apps (`#apps`): the owner's tools and apps in one place, opened from the
//! app header. First the links the host lists (`/api/v2/app-links`,
//! `docs/v2/app-links.md`) under the host's own headings, for example the
//! credential store's own UI with how to sign in there; then the live sites
//! his chats published (ORK-834), from the list the chat header and the Sites
//! page share. Every link opens in a new tab with no opener; the page never
//! fetches one. A new link in the host's file shows without a release.
use dioxus::prelude::*;
use orkestr_v2_ui::app_links::{self, Link, Links};
use orkestr_v2_ui::session_scope::SessionScope;
use orkestr_v2_ui::sites::{self, Catalog, Site};
use serde_json::Value;

#[component]
pub fn Apps(
    sites: crate::sites_view::SitesCatalog,
    session_scope: Signal<SessionScope>,
    onsites: EventHandler<()>,
) -> Element {
    let mut links = use_signal(Links::default);
    let mut reload = use_signal(|| 0_u64);
    // The published sites are read again when the page opens (the workspace
    // otherwise reads them once a minute).
    use_future(move || async move {
        let mut refresh = sites.refresh;
        refresh += 1;
    });
    // The host's links: when the page opens and on "Try again". A failure
    // never signs the owner out.
    use_resource(move || async move {
        let _ = reload();
        let generation = session_scope.peek().generation();
        let result = crate::transport::request::<app_links::Page>(
            "GET",
            "/api/v2/app-links",
            Value::Null,
            "",
            "",
        )
        .await
        .map_err(|e| (e.status, e.message));
        if !session_scope.peek().is_current(generation) {
            return;
        }
        links.set(Links::from_answer(result));
    });
    let tools = match links() {
        Links::Loading => rsx! {
            p { class: "apps-status", role: "status", "Loading tools…" }
        },
        // An older server without the list: its sites are still shown.
        Links::Unsupported => rsx! {},
        Links::Failed { status: 401, .. } => rsx! {
            p { class: "apps-status", role: "status",
                "Tools need a session signed in with your password. Sign in again."
            }
        },
        Links::Failed { message, .. } => rsx! {
            p { class: "apps-status", role: "status", "Tools could not be loaded. {message}" }
            button { r#type: "button", class: "apps-retry", onclick: move |_| {
                reload += 1;
            }, "Try again" }
        },
        Links::Ready(page) => {
            let groups = app_links::groups(&page);
            rsx! {
                if let Some(code) = page.error.as_deref() {
                    p { class: "apps-notice", role: "status", "{app_links::error_text(code)}" }
                } else if groups.is_empty() {
                    p { class: "apps-empty",
                        "No tools or apps are listed on this server yet. The host lists them in its app links file; a new one shows here without an update of this app."
                    }
                }
                for group in groups.iter() {
                    section { key: "{group.name}", class: "apps-group", "aria-label": "{group.name}",
                        h3 { "{group.name}" }
                        ul { class: "apps-grid",
                            for link in group.links.iter() {
                                LinkCard { key: "{link.id}", link: link.clone() }
                            }
                        }
                    }
                }
            }
        }
    };
    let catalog = (sites.catalog)();
    let live: Vec<Site> = match &catalog {
        Catalog::Ready(page) => app_links::live_sites(page),
        _ => Vec::new(),
    };
    let sites_note = match &catalog {
        Catalog::Loading => Some("Loading sites…"),
        Catalog::Ready(_) if live.is_empty() => {
            Some("No live sites yet. A chat publishes a folder as a site with orkestr-site publish <folder>.")
        }
        Catalog::Ready(_) => None,
        Catalog::Unsupported => Some("This server has no sites list yet."),
        Catalog::Failed { .. } => Some("Sites could not be loaded. All sites and versions says why."),
    };
    rsx! {
        section { class: "apps-page", "aria-label": "Apps",
            style { "{include_str!(\"apps.css\")}" }
            p { class: "apps-intro",
                "Your tools and apps, and the sites your chats published. Each opens in a new tab; sign in there if it asks."
            }
            {tools}
            section { class: "apps-group apps-sites", "aria-label": "Published sites",
                div { class: "apps-group-heading",
                    h3 { "Published sites" }
                    button { r#type: "button", class: "apps-all-sites", onclick: move |_| onsites.call(()),
                        "All sites and versions"
                    }
                }
                if let Some(note) = sites_note {
                    p { class: "apps-status", "{note}" }
                }
                if !live.is_empty() {
                    ul { class: "apps-grid",
                        for site in live.iter() {
                            SiteCard { key: "{site.slug}", site: site.clone() }
                        }
                    }
                }
            }
        }
    }
}

/// One tool or app: its name and address open it in a new tab with no
/// opener; what it is and how to sign in there follow as plain text.
#[component]
fn LinkCard(link: Link) -> Element {
    let Some(url) = link.link().map(str::to_owned) else {
        return rsx! {};
    };
    rsx! {
        li { class: "app-card", "data-app": "{link.id}",
            a { class: "app-link", href: "{url}", target: "_blank", rel: "noopener noreferrer",
                title: "Open {link.title} in a new tab",
                span { class: "app-title", "{link.title}" }
                ExternalIcon {}
                span { class: "app-address", "{link.address()}" }
            }
            if let Some(description) = link.description.as_deref() {
                p { class: "app-description", "{description}" }
            }
            if let Some(hint) = link.hint.as_deref() {
                p { class: "app-hint", "{hint}" }
            }
        }
    }
}

/// One live published site, linked like a tool; its kind below.
#[component]
fn SiteCard(site: Site) -> Element {
    let Some(url) = site.link().map(str::to_owned) else {
        return rsx! {};
    };
    let kind = sites::kind_label(&site.kind);
    rsx! {
        li { class: "app-card", "data-site": "{site.slug}",
            a { class: "app-link", href: "{url}", target: "_blank", rel: "noopener noreferrer",
                title: "Open {site.name()} in a new tab",
                span { class: "app-title", "{site.name()}" }
                ExternalIcon {}
                span { class: "app-address", "{site.address()}" }
            }
            p { class: "app-description", "{kind}" }
        }
    }
}

#[component]
fn ExternalIcon() -> Element {
    rsx! {
        svg { class: "app-external", "aria-hidden": "true", view_box: "0 0 20 20", width: "14", height: "14",
            path { d: "M11 3.5h5.5V9M16.5 3.5 9 11M14 12.5v3a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3", fill: "none", stroke: "currentColor", stroke_width: "1.6", stroke_linecap: "round", stroke_linejoin: "round" }
        }
    }
}
