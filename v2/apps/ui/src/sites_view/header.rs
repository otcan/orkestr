//! The chat header's Site link (ORK-834): the open chat's newest live site,
//! in a new tab. A chat with more sites also shows "+N", which opens the Sites
//! page. Nothing shows for a chat without a live site, an older server, or a
//! list that could not be read.
use super::SitesCatalog;
use dioxus::prelude::*;

#[component]
pub fn HeaderSiteLink(
    sites: SitesCatalog,
    conversation: String,
    onall: EventHandler<()>,
) -> Element {
    let Some(link) = (sites.catalog)().header_link(&conversation) else {
        return rsx! {};
    };
    let others = link.others;
    let more = match others {
        1 => "This chat has 1 more site: open Sites".to_owned(),
        n => format!("This chat has {n} more sites: open Sites"),
    };
    rsx! {
        div { class: "heading-site", role: "group", "aria-label": "Published site",
            a { class: "heading-site-link", href: "{link.url}", target: "_blank", rel: "noopener noreferrer",
                title: "Open {link.name} in a new tab",
                svg { "aria-hidden": "true", view_box: "0 0 20 20", width: "16", height: "16",
                    path { d: "M11 3.5h5.5V9M16.5 3.5 9 11M14 12.5v3a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3", fill: "none", stroke: "currentColor", stroke_width: "1.6", stroke_linecap: "round", stroke_linejoin: "round" }
                }
                span { "Site" }
                span { class: "visually-hidden", ": {link.name}" }
            }
            if others > 0 {
                button { r#type: "button", class: "heading-site-more", title: "{more}", "aria-label": "{more}",
                    onclick: move |_| onall.call(()), "+{others}" }
            }
        }
    }
}
