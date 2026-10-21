//! Browser bridges for calendar timers: owner writes (fixed paths, CSRF) and the
//! local clock used for pause inputs. Neither sends a clock or claim to the server.
use dioxus::prelude::*;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Deserialize)]
pub struct Reply {
    pub status: u16,
    pub body: Option<Value>,
    pub message: Option<String>,
}
impl Reply {
    pub fn ok(&self) -> bool {
        self.status == 200
    }
    /// Words for a refused request; the server's own message when it sent one.
    pub fn failure(&self) -> String {
        if let Some(message) = &self.message {
            return message.clone();
        }
        match self.status {
            400 => "That was not accepted. Check the schedule and the fields.".into(),
            401 | 403 => "Sign in again to change timers.".into(),
            404 => "That timer is no longer available.".into(),
            409 => "The timer changed in the meantime. The list was reloaded; try again.".into(),
            _ => "The change was not confirmed. Check the list before retrying.".into(),
        }
    }
}

pub async fn call(method: &str, path: &str, csrf: &str, body: Value) -> Result<Reply, String> {
    let eval = document::eval(include_str!("calendar_timer_request.js"));
    eval.send(json!({"method": method, "path": path, "csrf": csrf, "body": body}))
        .map_err(|_| "Timer bridge unavailable.".to_owned())?;
    eval.join::<Reply>().await.map_err(|_| {
        "Connection interrupted; the change may not have been saved. Check the list.".to_owned()
    })
}

async fn clock_op(op: &str, value: &str) -> Option<i64> {
    let eval = document::eval(include_str!("timer_clock.js"));
    eval.send(json!({"op": op, "value": value})).ok()?;
    eval.join::<Option<i64>>().await.ok().flatten()
}
/// The browser's current time, for hiding pauses that already ended.
pub async fn now_ms() -> i64 {
    clock_op("now", "").await.unwrap_or(0)
}
/// A `datetime-local` value as an instant (the browser's own zone).
pub async fn parse_local(value: &str) -> Option<i64> {
    clock_op("parse", value).await
}
pub async fn preset(name: &str) -> Option<i64> {
    clock_op("preset", name).await
}
