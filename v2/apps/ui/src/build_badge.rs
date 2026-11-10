use dioxus::prelude::*;
use orkestr_v2_ui::build_identity::identity;

#[component]
pub fn BuildBadge() -> Element {
    let mut expanded = use_signal(|| false);
    let mut deployment = use_signal(|| None::<String>);
    use_resource(move || async move {
        let result = crate::transport::request::<serde_json::Value>(
            "GET",
            "/api/v2/health",
            serde_json::Value::Null,
            "",
            "",
        )
        .await
        .ok();
        let value = result
            .as_ref()
            .and_then(|health| {
                let server = orkestr_v2_ui::build_identity::server_identity(health)?;
                let times = orkestr_v2_ui::deployment_times::parse(
                    health,
                    identity().source_commit,
                    server.source_commit.as_deref(),
                );
                Some(format!(
                    "Web deployed: {}\nServer deployed: {}",
                    orkestr_v2_ui::deployment_times::label(times.web),
                    orkestr_v2_ui::deployment_times::label(times.server)
                ))
            })
            .unwrap_or_else(|| "Deployment times unavailable".into());
        deployment.set(Some(value));
    });
    let build = identity();
    let source = build.source_commit.unwrap_or("Unknown (unpinned build)");
    let short = build.source_commit.map(|s| &s[..12]).unwrap_or("unknown");
    let hint = format!(
        "Web version: {}\nWeb source: {}\nClick for web and server build details.",
        build.version, source
    );
    let deployed = deployment().unwrap_or_else(|| "Checking deployment times…".into());
    rsx! {
        div { class: "build-badge",
            button { r#type: "button", title: "{hint}", "aria-label": "Build version details",
                "aria-expanded": "{expanded}", "aria-controls": "header-build-details",
                onclick: move |_| expanded.set(!expanded()),
                "v{build.version}"
                span { class: "build-badge-source", " · {short}" }
            }
            small { class: "deployment-times", title: "{deployed}", "aria-label": "Deployment times", "{deployed}" }
            if expanded() {
                div { id: "header-build-details", class: "build-badge-details", crate::about::About {} }
            }
        }
    }
}
