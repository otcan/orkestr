use dioxus::prelude::*;
use orkestr_v2_ui::build_identity::identity;

/// Compact version at the header's right edge (ORK-786). Full web and
/// server builds, commits and compile/deploy times are in its panel, which
/// mounts (and reads the server identity) only while open.
#[component]
pub fn BuildBadge() -> Element {
    let mut expanded = use_signal(|| false);
    let build = identity();
    let source = build.source_commit.unwrap_or("Unknown (unpinned build)");
    let short = build.source_commit.map(|s| &s[..7]).unwrap_or("unpinned");
    let hint = format!(
        "Web version: {}\nWeb source: {}\nClick for web and server build details.",
        build.version, source
    );
    let mut close = move || {
        expanded.set(false);
        let _ =
            document::eval("document.querySelector('.build-badge > button')?.focus();return null;");
    };
    rsx! {
        div { class: "build-badge",
            onkeydown: move |event| {
                if event.key() == Key::Escape && expanded() {
                    close();
                }
            },
            button { r#type: "button", title: "{hint}", "aria-label": "Build version details",
                "aria-expanded": "{expanded}", "aria-controls": "header-build-details",
                onclick: move |_| expanded.set(!expanded()),
                "v{build.version}"
                span { class: "build-badge-source", " · {short}" }
                crate::workspace::Chevron {}
            }
            if expanded() {
                div { id: "header-build-details", class: "build-badge-details", role: "region",
                    "aria-label": "Build, commit and deployment details",
                    crate::about::About {}
                    button { r#type: "button", class: "build-badge-close", onclick: move |_| close(), "Close" }
                }
            }
        }
    }
}
