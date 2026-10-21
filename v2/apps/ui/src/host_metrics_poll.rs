//! A polled, ETag-revalidated host metrics read bound to a signal.
use crate::host_metrics_fetch::{clock, sleep, start, Reply};
use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;
use serde::de::DeserializeOwned;
use serde_json::json;

#[derive(Clone, Copy)]
pub struct Polled<T: 'static> {
    pub value: Signal<Option<T>>,
    /// Browser time of the last answer (200 or 304), for staleness.
    pub received_ms: Signal<Option<i64>>,
    pub now_ms: Signal<i64>,
    pub offset_minutes: Signal<i64>,
    pub failed: Signal<bool>,
}

pub fn use_polled<T: DeserializeOwned + Clone + 'static>(
    path: &'static str,
    every_ms: u64,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    valid: fn(&T) -> bool,
) -> Polled<T> {
    let owner = session_scope.peek().generation();
    let mut value = use_signal(|| None::<T>);
    let mut received_ms = use_signal(|| None::<i64>);
    let mut now_ms = use_signal(|| 0_i64);
    let mut offset_minutes = use_signal(|| 0_i64);
    let mut failed = use_signal(|| false);
    let mut mounted = use_signal(|| true);
    let mut channel = use_signal(|| None::<document::Eval>);
    use_drop(move || {
        mounted.set(false);
        if let Some(eval) = channel.peek().as_ref() {
            let _ = eval.send(json!({"stop": true}));
        }
    });
    use_future(move || async move {
        let mut etag: Option<String> = None;
        loop {
            let eval = start(path, etag.as_deref());
            channel.set(Some(eval));
            let reply = eval.join::<Reply>().await;
            if !mounted() || !session_scope.read().is_current(owner) {
                return;
            }
            channel.set(None);
            let (wall, zone) = clock().await;
            now_ms.set(wall);
            offset_minutes.set(zone);
            match reply {
                Ok(Reply {
                    status: 200,
                    etag: tag,
                    text,
                }) => match serde_json::from_str::<T>(&text).ok().filter(valid) {
                    Some(parsed) => {
                        value.set(Some(parsed));
                        received_ms.set(Some(wall));
                        etag = tag;
                        failed.set(false);
                    }
                    None => failed.set(true),
                },
                Ok(Reply { status: 304, .. }) => {
                    received_ms.set(Some(wall));
                    failed.set(false);
                }
                Ok(Reply {
                    status: 401 | 403, ..
                }) => {
                    onexpired.call(());
                    return;
                }
                _ => failed.set(true),
            }
            sleep(every_ms).await;
            if !mounted() || !session_scope.read().is_current(owner) {
                return;
            }
        }
    });
    Polled {
        value,
        received_ms,
        now_ms,
        offset_minutes,
        failed,
    }
}
