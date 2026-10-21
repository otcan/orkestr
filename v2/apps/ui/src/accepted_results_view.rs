use crate::accepted_results_bridge::start;
use dioxus::prelude::*;
use orkestr_v2_contracts::{AcceptedResult, AcceptedResults, ProviderPayload};
use orkestr_v2_ui::chat_timeline::{self, Input, Row};
use orkestr_v2_ui::{
    accepted_results::{bound_payload, valid_page},
    payload::Output,
    session_scope::SessionScope,
};
use serde_json::{json, Value};
use std::{cell::Cell, collections::BTreeMap, rc::Rc};

#[component]
pub fn AcceptedReplies(
    id: String,
    #[props(default)] messages: Vec<Input>,
    #[props(default)] update: Option<Signal<i64>>,
    #[props(default)] inline: bool,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut mounted = use_signal(|| true);
    let mut channel = use_signal(|| None::<document::Eval>);
    let mut after = use_signal(|| 0_i64);
    let mut reload = use_signal(|| 0_u64);
    let mut page = use_signal(|| None::<AcceptedResults>);
    let mut collected = use_signal(BTreeMap::<i64, AcceptedResult>::new);
    let revision = use_hook(|| Rc::new(Cell::new(0_i64)));
    let read_ticket = use_hook(|| Rc::new(Cell::new(0_u64)));
    let mut notice = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut window_start = use_signal(|| 0_i64);
    let now = crate::message_time_view::use_now();
    let times = crate::message_time_view::use_message_times(id.clone(), window_start);
    use_drop(move || {
        mounted.set(false);
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    let read_id = id.clone();
    use_resource(move || {
        let cursor = after();
        let _ = reload();
        let accepted = update.map_or(0, |view| view());
        let is_live = inline && accepted > revision.get();
        let cursor = if is_live { accepted - 1 } else { cursor };
        if is_live {
            revision.set(accepted);
        }
        let ticket = read_ticket.get() + 1;
        read_ticket.set(ticket);
        let read_ticket = read_ticket.clone();
        let id = read_id.clone();
        async move {
            if let Some(old) = channel.peek().as_ref() {
                let _ = old.send(json!({"stop":true}));
            }
            busy.set(true);
            notice.set("Loading accepted replies…".into());
            let eval = start(json!({"conversation":id,"after":cursor.to_string()}), false);
            channel.set(Some(eval));
            let result = eval.join::<Value>().await;
            if !mounted() || !session_scope.read().is_current(owner) || read_ticket.get() != ticket
            {
                return;
            }
            busy.set(false);
            channel.set(None);
            match result {
                Ok(value) if value["status"] == 200 => {
                    match serde_json::from_str::<AcceptedResults>(
                        value["text"].as_str().unwrap_or(""),
                    ) {
                        Ok(results) if valid_page(&results, &id, cursor) => {
                            notice.set(
                                if results.results.is_empty() {
                                    "No accepted replies on this page."
                                } else {
                                    "Replies you explicitly accepted."
                                }
                                .into(),
                            );
                            if inline
                                && chat_timeline::merge_replies(
                                    &mut collected.write(),
                                    &results.results,
                                )
                                .is_err()
                            {
                                notice
                                    .set("Accepted reply identity changed. Reload history.".into());
                                return;
                            }
                            if !is_live {
                                page.set(Some(results));
                            }
                        }
                        _ => notice.set(
                            "Accepted replies could not be verified. Refresh to retry.".into(),
                        ),
                    }
                }
                Ok(value) if matches!(value["status"].as_u64(), Some(401 | 403)) => {
                    onexpired.call(())
                }
                _ => notice.set("Accepted replies unavailable. Refresh to retry.".into()),
            }
        }
    });
    let next = page.read().as_ref().and_then(|p| p.next_after_sequence);
    let results = if inline {
        collected.read().values().cloned().collect()
    } else {
        page.read()
            .as_ref()
            .map(|p| p.results.clone())
            .unwrap_or_default()
    };
    let rows = chat_timeline::ordered(&messages, &results);
    // Times start just before the oldest row on screen.
    let first = rows
        .as_ref()
        .ok()
        .and_then(|r| r.first().map(|row| row.sequence() - 1))
        .unwrap_or(0);
    if *window_start.peek() != first {
        window_start.set(first);
    }
    let times_now = times.read();
    rsx! { section { class: if inline { "chat-transcript" } else { "accepted-history" }, "aria-label":"Accepted replies",
        if !inline { h2 { "Accepted replies" } }
        if let Ok(rows) = rows {
            if inline && rows.is_empty() && !busy() { p { class: "empty-conversation", "Start a conversation. Your messages and accepted replies will appear here." } }
            ol { class: if inline { "chat-messages" } else { "messages" },
                for row in rows {
                    li { key: "{row.key()}", class: match &row { Row::Input(_) => "user-message", Row::Reply(_) => "assistant-message" },
                        match &row {
                            Row::Input(input) => rsx! { article { "data-message-id": "{input.id}",
                                strong { if input.actor == "owner" { "You" } else { "{input.actor}" } }
                                p { "{input.text}" }
                            } },
                            Row::Reply(reply) => rsx! { AcceptedReply { conversation:id.clone(), row:reply.clone(), session_scope, onexpired } },
                        }
                        if let Some(time) = times_now.get(&row.sequence()) {
                            crate::message_time_view::MessageTime { at_ms: time.at_ms, now_ms: now(), receipts: time.receipts.clone() }
                        }
                    }
                }
            }
        } else { p { role: "alert", "Conversation order could not be verified. Reload history." } }
        details { class: "transcript-pages",
            summary { "Reply history pages" }
            p { role:"status", "{notice}" }
            button { disabled:busy(), onclick:move |_|{after.set(0);reload+=1;}, "Refresh accepted replies" }
            button { disabled:busy()||next.is_none(), onclick:move |_|{if let Some(cursor)=next{after.set(cursor);}}, "Next 20 accepted replies" }
        }
    } }
}

#[component]
fn AcceptedReply(
    conversation: String,
    row: AcceptedResult,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut mounted = use_signal(|| true);
    let mut output = use_signal(Output::default);
    let mut notice = use_signal(|| {
        if row.payload_removed {
            "Reply output removed."
        } else if row.payload_id.is_none() {
            "No output was recorded for this accepted reply."
        } else {
            "Loading accepted reply…"
        }
        .to_string()
    });
    let mut channel = use_signal(|| None::<document::Eval>);
    use_drop(move || {
        mounted.set(false);
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    let load_row = row.clone();
    use_future(move || {
        let row = load_row.clone();
        let conversation = conversation.clone();
        async move {
            if row.payload_removed || row.payload_id.is_none() {
                return;
            }
            loop {
                if !mounted() || !session_scope.read().is_current(owner) {
                    return;
                }
                let eval = start(
                    json!({"conversation":conversation,"payload":row.payload_id.as_ref().unwrap().to_string()}),
                    true,
                );
                channel.set(Some(eval));
                let result = eval.join::<Value>().await;
                if !mounted() || !session_scope.read().is_current(owner) {
                    return;
                }
                channel.set(None);
                match result {
                    Ok(value) if value["status"] == 200 => {
                        let payload = serde_json::from_str::<ProviderPayload>(
                            value["text"].as_str().unwrap_or(""),
                        );
                        match payload {
                            Ok(payload) if bound_payload(&row, &conversation, &payload) => {
                                output.write().observed(payload.text);
                                notice.set(
                                    if output.read().removed() {
                                        "Reply output removed."
                                    } else {
                                        "Accepted reply"
                                    }
                                    .into(),
                                );
                                if output.read().removed() {
                                    return;
                                }
                            }
                            _ => {
                                output.write().unavailable();
                                notice.set("Accepted reply unavailable.".into());
                            }
                        }
                    }
                    Ok(value) if matches!(value["status"].as_u64(), Some(401 | 403)) => {
                        output.write().unavailable();
                        onexpired.call(());
                        return;
                    }
                    _ => {
                        output.write().unavailable();
                        notice.set("Accepted reply unavailable. Checking again…".into());
                    }
                }
                let _ = document::eval(
                    "await new Promise(resolve => setTimeout(resolve, 5000)); return null;",
                )
                .await;
            }
        }
    });
    let payload_id = row
        .payload_id
        .as_ref()
        .map(ToString::to_string)
        .unwrap_or_default();
    rsx! { article {
        "data-run-id": "{row.run_id}",
        "data-completion-event-id": "{row.completion_event_id}",
        "data-acceptance-event-id": "{row.acceptance_event_id}",
        "data-payload-id": "{payload_id}",
        strong { "Assistant" }
        span { class: "reply-state", if row.payload_removed { "Reply output removed." } else { "{notice}" } }
        if !row.payload_removed { if let Some(text)=output.read().text.as_ref(){pre { "data-accepted-output": "true", "{text}"}} }
        details {summary {"Reply details"} p {"Run: {row.run_id}"} p {"Completion: {row.completion_event_id}"} p {"Acceptance: {row.acceptance_event_id}"} p { if row.auto_accepted { "Accepted automatically by the server for you." } else { "Accepted by you." } }}
    } }
}
