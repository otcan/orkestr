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
    #[props(default)] conversation: Option<String>,
    session_scope: Signal<SessionScope>,
    onready: EventHandler<BetaDiscovery>,
    onexpired: EventHandler<()>,
) -> Element {
    let generation = session_scope.read().generation();
    let mut notice = use_signal(|| "Checking this conversation…".to_string());
    let requested = conversation.clone();
    let channel = use_hook(move || {
        let source =
            include_str!("beta_request.js").replace("export async function", "async function");
        let script = format!("{source}\nconst input=await dioxus.recv();const controller=new AbortController(); try {{ await Promise.race([(async()=>{{try{{await dioxus.send(await betaRequest({{...input,signal:controller.signal}}));}}catch{{await dioxus.send({{status:0,text:''}});}}}})(),dioxus.recv()]); }} finally {{controller.abort();}}");
        let eval = document::eval(&script);
        let _ = eval
            .send(json!({"route":"beta","method":"GET","body":null,"conversation":conversation}));
        eval
    });
    use_drop(move || {
        let _ = channel.send(json!({"stop":true}));
    });
    use_future(move || {
        let requested = requested.clone();
        async move {
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
                            && requested.as_ref().is_none_or(|id| *id == value.conversation_id.to_string())
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
                Ok(reply) => notice.set(unavailable_notice(reply.status, &reply.text).into()),
                Err(_) => notice.set(unavailable_notice(0, "").into()),
            }
        }
    });
    rsx! { p { role: "status", "{notice}" } }
}

/// Signed-in first screen before any model is connected: tell the owner what to do.
pub(crate) const MODELS_NOT_CONNECTED: &str = "Models are not connected yet. Sign in to Codex inside the container (Claude is optional), run configure, restart Orkestr, then reload this page. The V2 quickstart lists the exact commands.";
const DEEP_UNAVAILABLE: &str = "Deep is unavailable. Reload to check the server again.";

fn unavailable_notice(status: u16, text: &str) -> &'static str {
    #[derive(Deserialize)]
    struct Refusal {
        code: String,
    }
    match serde_json::from_str::<Refusal>(text) {
        Ok(refusal) if status == 404 && refusal.code == "beta_unconfigured" => MODELS_NOT_CONNECTED,
        _ => DEEP_UNAVAILABLE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_install_points_to_connecting_models() {
        let body = r#"{"code":"beta_unconfigured","message":"Beta execution is not configured","request_id":"r","retryable":false}"#;
        assert_eq!(unavailable_notice(404, body), MODELS_NOT_CONNECTED);
    }

    #[test]
    fn other_failures_keep_the_retry_notice() {
        assert_eq!(unavailable_notice(0, ""), DEEP_UNAVAILABLE);
        assert_eq!(
            unavailable_notice(503, r#"{"code":"unavailable"}"#),
            DEEP_UNAVAILABLE
        );
        assert_eq!(
            unavailable_notice(404, r#"{"code":"not_found"}"#),
            DEEP_UNAVAILABLE
        );
    }
}
