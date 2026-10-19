use dioxus::prelude::*;
use orkestr_v2_contracts::{BetaDiscovery, ExecutionWindowLimits};
use orkestr_v2_ui::session_scope::SessionScope;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Reply {
    status: u16,
    text: String,
}

#[component]
pub fn BetaDiscoveryGate(
    session_scope: Signal<SessionScope>,
    onready: EventHandler<BetaDiscovery>,
    onexpired: EventHandler<()>,
) -> Element {
    let generation = session_scope.read().generation();
    let mut notice = use_signal(|| "Checking the configured Deep conversation…".to_string());
    let channel = use_hook(move || {
        let source =
            include_str!("beta_request.js").replace("export async function", "async function");
        let script = format!("{source}\nconst controller=new AbortController(); try {{ await Promise.race([(async()=>{{try{{await dioxus.send(await betaRequest({{route:'beta',method:'GET',body:null,signal:controller.signal}}));}}catch{{await dioxus.send({{status:0,text:''}});}}}})(),dioxus.recv()]); }} finally {{controller.abort();}}");
        document::eval(&script)
    });
    use_drop(move || {
        let _ = channel.send(json!({"stop":true}));
    });
    use_future(move || async move {
        let mut receiver = channel;
        let reply = receiver.recv::<Reply>().await;
        let _ = channel.send(json!({"stop":true}));
        if !session_scope.read().is_current(generation) {
            return;
        }
        match reply {
            Ok(reply) if reply.status == 401 => onexpired.call(()),
            Ok(reply) if reply.status == 200 => {
                let decoded = serde_json::from_str::<BetaDiscovery>(&reply.text);
                match decoded {
                    Ok(value)
                        if value.schema_version == 1
                            && !value.conversation_id.0.is_nil()
                            && value.limits == ExecutionWindowLimits::default()
                            && value.window.as_ref().is_none_or(|window| {
                                window.conversation_id == value.conversation_id
                            }) =>
                    {
                        onready.call(value)
                    }
                    _ => notice.set(
                        "The configured conversation could not be verified. Reload to try again."
                            .into(),
                    ),
                }
            }
            _ => notice.set("Deep is unavailable. Reload to check the server again.".into()),
        }
    });
    rsx! { p { role: "status", "{notice}" } }
}
