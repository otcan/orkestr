use dioxus::prelude::*;
use orkestr_v2_contracts::{MessageReceipt, MessageTimesPage};
use orkestr_v2_ui::message_time;
use serde_json::Value;
use std::collections::BTreeMap;

/// The browser clock for "today" in message times, refreshed each minute.
pub fn use_now() -> Signal<i64> {
    let mut now = use_signal(|| 0_i64);
    use_future(move || async move {
        loop {
            if let Ok(value) = document::eval("return Date.now();").join::<f64>().await {
                now.set(value as i64);
            }
            crate::transport::sleep(60_000).await;
        }
    });
    now
}

/// A message time: short Berlin time; the full date and recorded receipts on
/// hover (title) or tap (details).
#[component]
pub fn MessageTime(
    at_ms: i64,
    now_ms: i64,
    #[props(default)] receipts: Vec<MessageReceipt>,
) -> Element {
    let mut open = use_signal(|| false);
    let full = message_time::full(at_ms);
    let short = message_time::short(at_ms, now_ms.max(at_ms));
    let mark = message_time::receipt_mark(&receipts);
    let title = std::iter::once(full.clone())
        .chain(receipts.iter().map(|r| match r.at_ms {
            Some(t) => format!(
                "{} · {}",
                message_time::receipt_label(r),
                message_time::full(t)
            ),
            None => message_time::receipt_label(r).to_owned(),
        }))
        .collect::<Vec<_>>()
        .join("\n");
    rsx! {
        span { class: "message-meta",
            button { class: "message-time", r#type: "button", title: "{title}", "aria-expanded": "{open}",
                "aria-label": "Sent {full}", onclick: move |_| open.set(!open()),
                time { "{short}" }
                if !mark.is_empty() { span { class: "receipt-mark", "aria-hidden": "true", " {mark}" } }
            }
            if open() {
                span { class: "message-time-details",
                    span { "{full}" }
                    for receipt in receipts.iter() {
                        span { class: "receipt-line",
                            "{message_time::receipt_label(receipt)}"
                            if let Some(t) = receipt.at_ms { " · {message_time::short(t, now_ms.max(t))}" }
                        }
                    }
                }
            }
        }
    }
}

/// Read interval against a server without the live channel (the old
/// refresh); with it, message times are read when they change.
const TIMES_REFRESH_MS: u32 = 15_000;

/// Times of native messages from `start` on (pages of 200). After the first
/// read the chat waits on the live channel for the last page read, where new
/// messages and their receipts land, and then reads only from that page on;
/// the whole window is read again every few reads and when older rows come
/// on screen (which also ends the wait at once). Nothing is read while
/// `start` is `None` (no row on screen yet).
pub fn use_message_times(
    id: String,
    start: Signal<Option<i64>>,
) -> Signal<BTreeMap<i64, orkestr_v2_contracts::MessageTime>> {
    let mut times = use_signal(BTreeMap::new);
    let mut waiting = use_signal(|| None::<document::Eval>);
    // A moved window ends the wait: older rows need their times now.
    use_effect(move || {
        let _ = start();
        if let Some(channel) = waiting.peek().as_ref() {
            let _ = channel.send(serde_json::json!({"start": true}));
        }
    });
    use_drop(move || {
        if let Some(channel) = waiting.peek().as_ref() {
            let _ = channel.send(serde_json::json!({"stop": true}));
        }
    });
    use_future(move || {
        let id = id.clone();
        async move {
            let mut read_from = None::<i64>;
            let mut tail = 0_i64;
            let mut reads = 0_u32;
            let mut watched = None::<(String, Option<u64>)>;
            loop {
                let Some(from) = *start.peek() else {
                    crate::transport::sleep(250).await;
                    continue;
                };
                let mut after = message_time::times_read_from(from, read_from, tail, reads);
                if after == from {
                    read_from = Some(from);
                }
                reads = reads.wrapping_add(1);
                let mut next = BTreeMap::new();
                for _ in 0..5 {
                    tail = after;
                    let path =
                        format!("/api/v2/conversations/{id}/message-times?after={after}&limit=200");
                    let Ok(page) = crate::transport::request::<MessageTimesPage>(
                        "GET",
                        &path,
                        Value::Null,
                        "",
                        "",
                    )
                    .await
                    else {
                        break;
                    };
                    if !page.is_valid() || page.conversation_id.to_string() != id {
                        break;
                    }
                    for t in page.times {
                        next.insert(t.sequence, t);
                    }
                    match page.next_after {
                        Some(n) if n > after => after = n,
                        _ => break,
                    }
                }
                if !next.is_empty() {
                    times.write().extend(next);
                }
                let path =
                    format!("/api/v2/conversations/{id}/message-times?after={tail}&limit=200");
                let since = match &watched {
                    Some((watched, since)) if *watched == path => *since,
                    _ => None,
                };
                let channel = crate::live::waiting(&path, since, TIMES_REFRESH_MS);
                waiting.set(Some(channel));
                // Older rows that came on screen during the read: no wait.
                if start
                    .peek()
                    .is_some_and(|now| read_from.is_none_or(|read| now < read))
                {
                    let _ = channel.send(serde_json::json!({"start": true}));
                }
                let wake = channel.join::<crate::live::Wake>().await;
                waiting.set(None);
                watched = Some((path, wake.ok().map(|wake| wake.version)));
            }
        }
    });
    times
}
