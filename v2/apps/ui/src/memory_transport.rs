use dioxus::prelude::*;
use orkestr_v2_ui::memory_client::MemoryRoute;
use serde_json::{json, Value};

pub async fn request(
    route: MemoryRoute,
    method: &str,
    body: Option<String>,
    csrf: &str,
    mut channel: Signal<Option<document::Eval>>,
) -> Result<(u16, String), String> {
    let route = match route {
        MemoryRoute::Settings => "settings",
        MemoryRoute::Proposals => "proposals",
        MemoryRoute::Decisions => "decisions",
        MemoryRoute::Query => "query",
        MemoryRoute::Export => "export",
    };
    let source =
        include_str!("memory_request.js").replace("export async function", "async function");
    let script = format!("{source}\nconst input=await dioxus.recv();const controller=new AbortController();input.signal=controller.signal;dioxus.recv().then(()=>controller.abort()).catch(()=>controller.abort());try{{await dioxus.send(await memoryRequest(input));}}catch(e){{await dioxus.send({{status:0,text:'Memory request not confirmed.'}});}}");
    let mut eval = document::eval(&script);
    eval.send(json!({"route":route,"method":method,"body":body,"csrf":csrf}))
        .map_err(|_| "Memory request not confirmed.")?;
    channel.set(Some(eval));
    let response = eval
        .recv::<Value>()
        .await
        .map_err(|_| "Memory request not confirmed.")?;
    channel.set(None);
    Ok((
        response["status"].as_u64().unwrap_or(0) as u16,
        response["text"].as_str().unwrap_or("").to_string(),
    ))
}

pub fn export_file(text: &str) -> Result<(), String> {
    let source = include_str!("memory_export.js").replace("export function", "function");
    let script = format!("{source}\nconst text=await dioxus.recv();offerMemoryExport(text);");
    let eval = document::eval(&script);
    eval.send(text)
        .map_err(|_| "Export could not be offered for download.".into())
}
