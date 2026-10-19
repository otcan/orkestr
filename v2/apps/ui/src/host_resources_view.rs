use dioxus::prelude::*;
use orkestr_v2_contracts::HostResourceHealth;
use orkestr_v2_ui::{host_resources::HostResources, session_scope::SessionScope};
use serde_json::{json, Value};

#[component]
pub fn HostResourcesView(
    session_scope: Signal<SessionScope>,
    mut resources: Signal<HostResources>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner_generation = session_scope.read().generation();
    let generation = use_hook(move || resources.write().begin_view());
    let mut now = use_signal(|| 0u64);
    let channel = use_hook(move || {
        let eval = document::eval(include_str!("execution_poll.js"));
        let _ = eval.send(json!({"path":"/api/v2/resources"}));
        eval
    });
    use_drop(move || {
        let _ = channel.send(json!({"stop":true}));
    });
    use_future(move || async move {
        let mut channel = channel;
        while let Ok(message) = channel.recv::<Value>().await {
            if !session_scope.read().is_current(owner_generation)
                || !resources.read().is_current(generation)
            {
                let _ = channel.send(json!({"stop":true}));
                return;
            }
            let Some(received) = message["now"].as_u64() else {
                continue;
            };
            now.set(received);
            match message["kind"].as_str() {
                Some("tick") => {}
                Some("response") => match message["status"].as_u64() {
                    Some(200) => {
                        let sample =
                            serde_json::from_value::<HostResourceHealth>(message["body"].clone());
                        if sample.ok().is_none_or(|sample| {
                            resources
                                .write()
                                .apply(generation, received, sample)
                                .is_err()
                        }) {
                            resources.write().disconnected(generation);
                        }
                    }
                    Some(401 | 403) => {
                        let _ = channel.send(json!({"stop":true}));
                        onexpired.call(());
                        return;
                    }
                    _ => resources.write().disconnected(generation),
                },
                _ => resources.write().disconnected(generation),
            }
        }
        let _ = channel.send(json!({"stop":true}));
        resources.write().disconnected(generation);
    });
    let model = resources.read();
    rsx! {
        section { "aria-label": "Host resources",
            h2 { "Host resources" }
            p { "Aggregate CPU and RAM for this server. These values cover the whole host, including other applications; they are not per-run usage." }
            p { role: "status", "{model.status(now())}" }
            dl {
                dt { "Host CPU" } dd { "{model.cpu(now())}" }
                dt { "Host RAM" } dd { "{model.memory(now())}" }
            }
            p { "RAM available includes reclaimable memory. CPU measures busy time across all host CPUs." }
        }
    }
}
