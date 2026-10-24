//! Same-origin tracker requests and durable, owner-scoped decision recovery.
use dioxus::prelude::*;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Deserialize)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}
impl Reply {
    pub fn ok(&self) -> bool {
        self.status == 200
    }
    pub fn failure(&self) -> String {
        if self.status == 401 || self.status == 403 {
            return "Sign in again to continue.".into();
        }
        self.body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The result is not confirmed. Check its status before retrying.")
            .to_owned()
    }
}
async fn bridge(input: Value) -> Result<Value, String> {
    let source = include_str!("tracker_client.mjs").replace("export ", "");
    let program = format!("{source}\nconst input = await dioxus.recv();\nif (input.op === 'request') {{ const controller = new AbortController(); let finished = false; dioxus.recv().then(() => {{ if (!finished) controller.abort(); }}); const timeout = setTimeout(() => controller.abort(), 15000); try {{ return await trackerRequest(input, globalThis.fetch, controller.signal); }} finally {{ finished = true; clearTimeout(timeout); controller.abort(); }} }}\nconst journal = trackerJournal(localStorage, input.binding, input.conversation);\nif (input.op === 'load') return journal.load();\nif (input.op === 'save') return journal.save(input.kind, input.body);\nif (input.op === 'clear') {{ journal.clear(input.key); return null; }}\nthrow new Error('Unknown tracker operation');");
    let eval = document::eval(&program);
    eval.send(input)
        .map_err(|_| "Tracker unavailable.".to_owned())?;
    eval.join::<Value>().await.map_err(|_| {
        "Connection interrupted. Your saved decision can be checked or retried.".to_owned()
    })
}
pub async fn call(method: &str, path: &str, csrf: &str, body: Value) -> Result<Reply, String> {
    serde_json::from_value(
        bridge(json!({"op":"request","method":method,"path":path,"csrf":csrf,"body":body})).await?,
    )
    .map_err(|_| "Tracker response unavailable.".into())
}
pub async fn journal(
    op: &str,
    binding: &str,
    conversation: &str,
    kind: &str,
    body: Value,
) -> Result<Value, String> {
    bridge(json!({"op":op,"binding":binding,"conversation":conversation,"kind":kind,"key":body.get("request_key"),"body":body})).await
}
