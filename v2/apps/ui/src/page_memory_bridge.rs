//! Tab-scoped browser storage for page recovery. Failures degrade to page memory.
use dioxus::prelude::*;
use serde_json::json;

const GUARD: &str =
    "if(typeof k!=='string'||!/^orkestr\\.v2\\.page\\.[0-9a-f-]{36}$/.test(k))return null;";

pub async fn load(key: &str) -> Option<String> {
    let eval = document::eval(&format!(
        "const k=await dioxus.recv();{GUARD}try{{return sessionStorage.getItem(k);}}catch{{return null;}}"
    ));
    eval.send(json!(key)).ok()?;
    eval.join::<Option<String>>().await.ok().flatten()
}

pub fn store(key: &str, value: Option<String>) {
    let eval = document::eval(&format!(
        "const [k,v]=await dioxus.recv();{GUARD}try{{if(v===null)sessionStorage.removeItem(k);else sessionStorage.setItem(k,v);}}catch{{}}return null;"
    ));
    let _ = eval.send(json!([key, value]));
}
