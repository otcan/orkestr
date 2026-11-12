use dioxus::prelude::*;
use serde_json::Value;
pub fn start(input: Value, payload: bool) -> document::Eval {
    if payload {
        run(
            include_str!("accepted_payload_request.mjs"),
            "acceptedPayload",
            input,
        )
    } else {
        run(
            include_str!("accepted_results_request.mjs"),
            "acceptedResults",
            input,
        )
    }
}
/// The texts of several accepted replies in one read (ORK-797).
pub fn start_batch(input: Value) -> document::Eval {
    run(
        include_str!("accepted_payload_request.mjs"),
        "acceptedPayloads",
        input,
    )
}
fn run(source: &str, function: &str, input: Value) -> document::Eval {
    let source = source.replace("export async function", "async function");
    let script = format!("{source}\nconst input=await dioxus.recv(); const c=new AbortController(); let finished=false; dioxus.recv().then(()=>{{if(!finished)c.abort();}}); try{{return await {function}({{...input,signal:c.signal}});}}finally{{finished=true;c.abort();}}");
    let eval = document::eval(&script);
    let _ = eval.send(input);
    eval
}
