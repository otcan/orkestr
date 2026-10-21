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

/// Times of native messages from `start` on (pages of 200), refreshed every
/// 15 s so receipts recorded later appear.
pub fn use_message_times(
    id: String,
    start: Signal<i64>,
) -> Signal<BTreeMap<i64, orkestr_v2_contracts::MessageTime>> {
    let mut times = use_signal(BTreeMap::new);
    use_future(move || {
        let id = id.clone();
        async move {
            loop {
                let mut after = (*start.peek()).max(0);
                let mut next = BTreeMap::new();
                for _ in 0..5 {
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
                crate::transport::sleep(15_000).await;
            }
        }
    });
    times
}
