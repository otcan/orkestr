use dioxus::prelude::*;
use orkestr_v2_ui::build_identity::{identity, server_identity, ServerIdentity, RECORD};

#[component]
pub fn About() -> Element {
    let mut backend = use_signal(|| None::<Result<ServerIdentity, ()>>);
    let mut revision = use_signal(|| 0_u64);
    use_resource(move || async move {
        let _ = revision();
        backend.set(None);
        let result = crate::transport::request::<serde_json::Value>(
            "GET",
            "/api/v2/health",
            serde_json::Value::Null,
            "",
            "",
        )
        .await
        .ok()
        .and_then(|value| server_identity(&value))
        .ok_or(());
        backend.set(Some(result));
    });
    let build = identity();
    let source = build.source_commit.unwrap_or("Unknown (unpinned build)");
    rsx! {
        section { "aria-label":"About Orkestr", h2 { "About Orkestr" }
            p { "Web version: {build.version}" }
            p { "Source: {source}" }
            match backend() {
                None => rsx! { p { "Server version: checking…" } },
                Some(Err(())) => rsx! { p { role: "status", "Server version: unavailable (request failed or invalid identity)" } },
                Some(Ok(server)) => {
                    let source = server.source_commit.as_deref().unwrap_or("Unknown (unpinned build)");
                    rsx! {
                        p { "Server version: {server.version}" }
                        p { "Server source: {source}" }
                    }
                },
            }
            button { onclick: move |_| revision += 1, "Refresh server identity" }
            if let Some(error)=build.error {p {role:"alert","{error}"}}
            p { "Build identity identifies these web assets. The server identity is read separately. Different sources can be intentional; these values do not verify release acceptance, compatibility or provider readiness." }
            details {summary {"Embedded web build record"} code {"{RECORD}"}}
        }
    }
}
