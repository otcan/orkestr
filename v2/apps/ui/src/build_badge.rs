use dioxus::prelude::*;
use orkestr_v2_ui::build_identity::identity;

#[component]
pub fn BuildBadge() -> Element {
    let mut expanded = use_signal(|| false);
    let build = identity();
    let source = build.source_commit.unwrap_or("Unknown (unpinned build)");
    let short = build.source_commit.map(|s| &s[..12]).unwrap_or("unknown");
    let hint = format!(
        "Web version: {}\nWeb source: {}\nClick for web and server build details.",
        build.version, source
    );
    rsx! {
        div { class: "build-badge",
            button { r#type: "button", title: "{hint}", "aria-label": "Build version details",
                "aria-expanded": "{expanded}", "aria-controls": "header-build-details",
                onclick: move |_| expanded.set(!expanded()),
                "v{build.version}"
                span { class: "build-badge-source", " · {short}" }
            }
            if expanded() {
                div { id: "header-build-details", class: "build-badge-details", crate::about::About {} }
            }
        }
    }
}
