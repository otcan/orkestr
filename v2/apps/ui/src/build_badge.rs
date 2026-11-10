use dioxus::prelude::*;
use orkestr_v2_ui::build_identity::identity;

#[component]
pub fn BuildBadge() -> Element {
    let build = identity();
    let source = build.source_commit.unwrap_or("Unknown (unpinned build)");
    let short = build.source_commit.map(|s| &s[..12]).unwrap_or("unknown");
    let hint = format!(
        "Web version: {}\nWeb source: {}\nClick for web and server build details.",
        build.version, source
    );
    rsx! {
        details { class: "build-badge",
            summary { title: "{hint}", "aria-label": "Build version details",
                "v{build.version}"
                span { class: "build-badge-source", " · {short}" }
            }
            div { class: "build-badge-details", crate::about::About {} }
        }
    }
}
