use dioxus::prelude::*;
use serde_json::Value;
pub fn start(input: Value, payload: bool) -> document::Eval {
    let source = if payload {
        include_str!("accepted_payload_request.mjs")
            .replace("export async function", "async function")
    } else {
        include_str!("accepted_results_request.mjs")
            .replace("export async function", "async function")
    };
    let function = if payload {
        "acceptedPayload"
    } else {
        "acceptedResults"
    };
    let script = format!("{source}\nconst input=await dioxus.recv(); const c=new AbortController(); let finished=false; dioxus.recv().then(()=>{{if(!finished)c.abort();}}); try{{return await {function}({{...input,signal:c.signal}});}}finally{{finished=true;c.abort();}}");
    let eval = document::eval(&script);
    let _ = eval.send(input);
    eval
}
