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

pub async fn export_file(
    text: &str,
    mut channel: Signal<Option<document::Eval>>,
    allowed: impl Fn() -> bool + 'static,
) -> Result<(), String> {
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    {
        let allowed = std::rc::Rc::new(allowed);
        let check = allowed.clone();
        let guard = crate::memory_export_guard::Guard::new(move || check());
        let source = include_str!("memory_export.js").replace("export function", "function");
        let script = format!("{source}\nconst input=await dioxus.recv();const allowed=()=>globalThis[Symbol.for('orkestr.memory.export.guards')]?.get(input.guard)?.()===true;if(!allowed())throw Error('Memory export retired');await dioxus.send(true);const payload=await dioxus.recv();if(!allowed()||typeof payload.text!=='string')throw Error('Memory export retired');offerMemoryExport(payload.text,undefined,allowed);return true;");
        let mut eval = document::eval(&script);
        channel.set(Some(eval));
        let result = async {
            eval.send(json!({"guard":guard.id()}))
                .map_err(|_| "Export could not be offered for download.".to_string())?;
            eval.recv::<bool>()
                .await
                .map_err(|_| "Export retired before transfer.".to_string())?;
            if !allowed() {
                return Err("Export retired before transfer.".into());
            }
            eval.send(json!({"text":text}))
                .map_err(|_| "Export retired before transfer.".to_string())?;
            eval.join::<bool>()
                .await
                .map_err(|_| "Export offer was not confirmed.".to_string())?;
            Ok(())
        }
        .await;
        channel.set(None);
        drop(guard);
        result
    }
    #[cfg(not(all(feature = "web", target_arch = "wasm32")))]
    {
        let _ = (text, &mut channel, allowed);
        Err("File export requires the web client.".into())
    }
}

/// Browser wall time is provenance metadata, independent of exact u64 revisions.
pub async fn capture_time() -> Result<i64, String> {
    let source = include_str!("memory_capture.js").replace("export function", "function");
    document::eval(&format!("{source}\nreturn memoryCaptureTime();"))
        .join::<i64>()
        .await
        .map_err(|_| {
            "Could not read capture time. Check your device clock and try again.".to_string()
        })
}
