use crate::accepted_results_bridge::start;
use dioxus::prelude::*;
use orkestr_v2_contracts::{AcceptedResult, AcceptedResults, ProviderPayload};
use orkestr_v2_ui::{
    accepted_results::{bound_payload, valid_page},
    payload::Output,
    session_scope::SessionScope,
};
use serde_json::{json, Value};

#[component]
pub fn AcceptedReplies(
    id: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut mounted = use_signal(|| true);
    let mut channel = use_signal(|| None::<document::Eval>);
    let mut after = use_signal(|| 0_i64);
    let mut reload = use_signal(|| 0_u64);
    let mut page = use_signal(|| None::<AcceptedResults>);
    let mut notice = use_signal(String::new);
    let mut busy = use_signal(|| false);
    use_drop(move || {
        mounted.set(false);
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    use_resource(move || {
        let cursor = after();
        let _ = reload();
        let id = id.clone();
        async move {
            busy.set(true);
            page.set(None);
            notice.set("Loading accepted replies…".into());
            let eval = start(json!({"conversation":id,"after":cursor.to_string()}), false);
            channel.set(Some(eval));
            let result = eval.join::<Value>().await;
            if !mounted() || !session_scope.read().is_current(owner) {
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
                            page.set(Some(results));
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
    rsx! { section { "aria-label":"Accepted replies",
        h2 { "Accepted replies" } p {role:"status","{notice}"}
        if let Some(results)=page.read().as_ref() {
            ol { class:"messages", for row in &results.results {
                li { key:"{row.acceptance_event_id}", AcceptedReply { conversation:results.conversation_id.to_string(), row:row.clone(), session_scope, onexpired } }
            } }
        }
        button { disabled:busy(), onclick:move |_|{after.set(0);reload+=1;}, "Refresh accepted replies" }
        button { disabled:busy()||next.is_none(), onclick:move |_|{if let Some(cursor)=next{after.set(cursor);}}, "Next 20 accepted replies" }
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
    rsx! { article { p {"{notice}"} if let Some(text)=output.read().text.as_ref(){pre {"{text}"}}
        details {summary {"Reply details"} p {"Run: {row.run_id}"} p {"Completion: {row.completion_event_id}"} p {"Acceptance: {row.acceptance_event_id}"}}
    } }
}
