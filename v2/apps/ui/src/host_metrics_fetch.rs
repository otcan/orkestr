//! Bridge for the owner host metrics reads (see `host_metrics_request.mjs`).
use dioxus::prelude::*;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
pub struct Reply {
    pub status: u16,
    pub etag: Option<String>,
    pub text: String,
}

/// One GET; the returned channel aborts it when sent anything.
pub fn start(path: &str, etag: Option<&str>) -> document::Eval {
    let source = include_str!("host_metrics_request.mjs")
        .replace("export const", "const")
        .replace("export async function", "async function");
    let script = format!("{source}\nconst input=await dioxus.recv();const c=new AbortController();let done=false;dioxus.recv().then(()=>{{if(!done)c.abort();}});try{{return await hostMetricsRequest({{...input,signal:c.signal}});}}finally{{done=true;c.abort();}}");
    let eval = document::eval(&script);
    let _ = eval.send(json!({"path": path, "etag": etag}));
    eval
}

/// Browser wall clock and local time zone offset (minutes, as `Date` gives it).
pub async fn clock() -> (i64, i64) {
    document::eval("return [Date.now(), new Date().getTimezoneOffset()];")
        .join::<(i64, i64)>()
        .await
        .unwrap_or((0, 0))
}

pub async fn sleep(ms: u64) {
    let _ = document::eval(&format!(
        "await new Promise(r=>setTimeout(r,{ms}));return null;"
    ))
    .await;
}
