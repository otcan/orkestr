use dioxus::prelude::*;
use orkestr_v2_contracts::ConversationSnapshot;
use orkestr_v2_ui::Projection;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct Failure {
    pub status: u16,
    pub message: String,
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self { status: 0, message }
    }
}

#[derive(Clone, Deserialize)]
pub struct BrowserSession {
    pub csrf_token: String,
    pub global_conversation_id: String,
}

#[derive(Deserialize)]
struct Response {
    status: u16,
    body: Value,
}

pub async fn request<T: DeserializeOwned>(
    method: &str,
    path: &str,
    body: Value,
    csrf: &str,
    bootstrap: &str,
) -> Result<T, Failure> {
    let eval = document::eval(include_str!("request.js"));
    eval.send(json!({"method":method,"path":path,"body":body,"csrf":csrf,"bootstrap":bootstrap}))
        .map_err(|_| Failure::from("Browser bridge unavailable".to_string()))?;
    let response: Response = eval.join().await.map_err(|_| {
        Failure::from(
            "Connection interrupted; receipt unknown. Retry retains the same request.".to_string(),
        )
    })?;
    if !(200..300).contains(&response.status) {
        return Err(Failure {
            status: response.status,
            message: response.body["message"]
                .as_str()
                .unwrap_or("API request rejected")
                .into(),
        });
    }
    serde_json::from_value(response.body)
        .map_err(|_| Failure::from("Unexpected API contract".to_string()))
}

/// Like [`request`], also returning the success status (for example 201 vs
/// 202 when a multi-stage operation stopped early).
pub async fn request_status<T: DeserializeOwned>(
    method: &str,
    path: &str,
    body: Value,
    csrf: &str,
) -> Result<(u16, T), Failure> {
    let eval = document::eval(include_str!("request.js"));
    eval.send(json!({"method":method,"path":path,"body":body,"csrf":csrf,"bootstrap":""}))
        .map_err(|_| Failure::from("Browser bridge unavailable".to_string()))?;
    let response: Response = eval.join().await.map_err(|_| {
        Failure::from(
            "Connection interrupted; outcome unknown. Retry continues the same request."
                .to_string(),
        )
    })?;
    if !(200..300).contains(&response.status) {
        return Err(Failure {
            status: response.status,
            message: response.body["message"]
                .as_str()
                .unwrap_or("API request rejected")
                .into(),
        });
    }
    serde_json::from_value(response.body)
        .map(|value| (response.status, value))
        .map_err(|_| Failure::from("Unexpected API contract".to_string()))
}

pub async fn key() -> Result<String, Failure> {
    document::eval("return crypto.randomUUID();")
        .join()
        .await
        .map_err(|_| Failure::from("Secure request ID generation unavailable".to_string()))
}

/// Request key of a message typed in the composer: `web:<uuid>`, so the
/// WhatsApp adapter can tell web input apart from its own intake.
pub async fn message_key() -> Result<String, Failure> {
    key()
        .await
        .map(|key| format!("{}{key}", orkestr_v2_contracts::WEB_MESSAGE_KEY_PREFIX))
}

pub async fn sleep(ms: u32) {
    let _ = document::eval(&format!(
        "await new Promise(resolve => setTimeout(resolve, {ms})); return null;"
    ))
    .await;
}

pub async fn delay() {
    let _ = document::eval("await new Promise(resolve => setTimeout(resolve, 1500)); return null;")
        .await;
}

pub async fn history_page(
    id: &str,
    csrf: &str,
    after: i64,
) -> Result<ConversationSnapshot, Failure> {
    let page: ConversationSnapshot = request(
        "GET",
        &format!("/api/v2/conversations/{id}?after={after}&limit=100"),
        Value::Null,
        csrf,
        "",
    )
    .await?;
    if page.conversation_id.to_string() != id {
        return Err("Snapshot scope mismatch".to_string().into());
    }
    if page.last_sequence < after {
        return Err("Snapshot watermark moved backwards".to_string().into());
    }
    if page
        .messages
        .iter()
        .any(|message| message.sequence <= after)
        || page.next_cursor.is_some_and(|next| next <= after)
    {
        return Err("Invalid snapshot cursor".to_string().into());
    }
    Ok(page)
}

pub async fn snapshot(
    id: &str,
    csrf: &str,
    after: i64,
    projection: Projection,
    required_watermark: i64,
) -> Result<Projection, Failure> {
    orkestr_v2_ui::reconcile(id, after, &projection, required_watermark, |cursor| {
        history_page(id, csrf, cursor)
    })
    .await
}

use orkestr_v2_ui::StreamItem;

pub async fn event(id: &str, cursor: i64) -> Result<StreamItem, Failure> {
    let eval = document::eval(include_str!("stream.js"));
    eval.send(json!({"path":format!("/api/v2/conversations/{id}/events"),"cursor":cursor}))
        .map_err(|_| Failure::from("Stream bridge unavailable".to_string()))?;
    let raw: Value = eval
        .join()
        .await
        .map_err(|_| Failure::from("Connection lost. Reconnecting…".to_string()))?;
    Ok(orkestr_v2_ui::decode_stream(raw))
}

/// Waits up to `ms` (with jitter), returning early when the tab becomes
/// visible, the window regains focus, the browser comes back online, or the
/// owner presses Retry.
pub async fn wait_for_wake(ms: u32) {
    let _ = document::eval(&include_str!("stream_wake.js").replace("__WAIT_MS__", &ms.to_string()))
        .await;
}

/// Wakes a stream that is waiting to reconnect (the Retry button).
pub fn retry_stream() {
    let _ = document::eval(&format!(
        "window.dispatchEvent(new Event({:?})); return null;",
        orkestr_v2_ui::live_stream::RETRY_EVENT
    ));
}

/// A per-viewer preference; `None` when storage is unavailable or blocked.
pub async fn stored_flag(key: &str) -> Option<bool> {
    let script = format!(
        "try {{ const v = localStorage.getItem({key:?}); return v === null ? null : v === '1'; }} catch {{ return null; }}"
    );
    document::eval(&script)
        .join::<Option<bool>>()
        .await
        .ok()
        .flatten()
}

/// Remembers a per-viewer preference; storage failures are ignored.
pub fn store_flag(key: &str, value: bool) {
    let v = if value { "1" } else { "0" };
    let _ = document::eval(&format!(
        "try {{ localStorage.setItem({key:?}, {v:?}); }} catch {{}} return null;"
    ));
}
