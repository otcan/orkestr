use dioxus::prelude::*;
use orkestr_v2_ui::build_identity::{identity, RECORD};

#[component]
pub fn About() -> Element {
    let build = identity();
    let source = build.source_commit.unwrap_or("Unknown (unpinned build)");
    rsx! {
        section { "aria-label":"About Orkestr", h2 { "About Orkestr" }
            p { "Web version: {build.version}" }
            p { "Source: {source}" }
            if let Some(error)=build.error {p {role:"alert","{error}"}}
            p { "Build identity identifies these web assets. It does not confirm server pairing, release acceptance or provider readiness." }
            details {summary {"Embedded web build record"} code {"{RECORD}"}}
        }
    }
}
