use dioxus::prelude::*;
use orkestr_v2_ui::build_identity::{identity, server_identity, ServerIdentity, RECORD};

#[component]
pub fn About() -> Element {
    let mut backend = use_signal(|| None::<Result<ServerIdentity, ()>>);
    let mut deployments = use_signal(orkestr_v2_ui::deployment_times::DeploymentTimes::default);
    let mut revision = use_signal(|| 0_u64);
    use_resource(move || async move {
        let _ = revision();
        backend.set(None);
        let response = crate::transport::request::<serde_json::Value>(
            "GET",
            "/api/v2/health",
            serde_json::Value::Null,
            "",
            "",
        )
        .await.ok();
        let result = response.as_ref().and_then(server_identity).ok_or(());
        deployments.set(response.as_ref().map(|health| orkestr_v2_ui::deployment_times::parse(health,
            identity().source_commit,result.as_ref().ok().and_then(|server|server.source_commit.as_deref())))
            .unwrap_or_default());
        backend.set(Some(result));
    });
    let build = identity();
    let source = build.source_commit.unwrap_or("Unknown (unpinned build)");
    let web_compiled = orkestr_v2_ui::deployment_times::label(orkestr_v2_ui::build_identity::compiled_at());
    let web_deployed = orkestr_v2_ui::deployment_times::label(deployments().web);
    let server_deployed = orkestr_v2_ui::deployment_times::label(deployments().server);
    rsx! {
        section { "aria-label":"About Orkestr", h2 { "About Orkestr" }
            p { "Web version: {build.version}" }
            p { "Source: {source}" }
            p { "Web compiled: {web_compiled}" }
            p { "Web deployed: {web_deployed}" }
            match backend() {
                None => rsx! { p { "Server version: checking…" } },
                Some(Err(())) => rsx! { p { role: "status", "Server version: unavailable (request failed or invalid identity)" } },
                Some(Ok(server)) => {
                    let source = server.source_commit.as_deref().unwrap_or("Unknown (unpinned build)");
                    let compiled = orkestr_v2_ui::deployment_times::label(server.compiled_at_unix);
                    rsx! {
                        p { "Server version: {server.version}" }
                        p { "Server source: {source}" }
                        p { "Server compiled: {compiled}" }
                        p { "Server deployed: {server_deployed}" }
                    }
                },
            }
            button { onclick: move |_| revision += 1, "Refresh server identity" }
            if let Some(error)=build.error {p {role:"alert","{error}"}}
            p { "Compilation timestamps record build-script execution in each artifact. Deployment timestamps are source-bound operator activation records, not uptime or the browser clock." }
            p { "Build identity identifies these web assets. The server identity is read separately. Different sources can be intentional; these values do not verify release acceptance, compatibility or provider readiness." }
            details {summary {"Embedded web build record"} code {"{RECORD}"}}
        }
    }
}
