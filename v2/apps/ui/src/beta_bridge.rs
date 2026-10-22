use dioxus::prelude::*;
use serde::Deserialize;
use serde_json::json;
#[derive(Deserialize)]
pub struct Reply {
    pub status: u16,
    pub text: String,
    /// Fixed refusal code the bridge may surface (`restricted_conversation`).
    #[serde(default)]
    pub code: String,
}
pub fn start(method: &str, conversation: &str, csrf: &str, body: Option<String>) -> document::Eval {
    start_route("window", method, conversation, csrf, body)
}
pub fn start_route(
    route: &str,
    method: &str,
    conversation: &str,
    csrf: &str,
    body: Option<String>,
) -> document::Eval {
    let source = include_str!("beta_request.js").replace("export async function", "async function");
    let script = format!("{source}\nconst input=await dioxus.recv(); const controller=new AbortController();input.signal=controller.signal;try{{await Promise.race([(async()=>{{try{{await dioxus.send(await betaRequest(input));}}catch{{await dioxus.send({{status:0,text:''}});}}}})(),dioxus.recv()]);}}finally{{controller.abort();}}");
    let eval = document::eval(&script);
    let _ = eval.send(
        json!({"route":route,"method":method,"conversation":conversation,"csrf":csrf,"body":body}),
    );
    eval
}
pub fn stop(eval: Option<document::Eval>) {
    if let Some(eval) = eval {
        let _ = eval.send(json!({"stop":true}));
    }
}
