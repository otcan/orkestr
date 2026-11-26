use dioxus::prelude::*;
use orkestr_v2_contracts::{ExecutionStatus, ExecutionWindowQueue};
use orkestr_v2_ui::{
    conversation_status::{row_status, valid_execution, valid_queue, RowStatus, Slots},
    session_scope::SessionScope,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Read {
    status: u16,
    text: String,
}
#[derive(Deserialize)]
struct Row {
    id: String,
    execution: Read,
    queue: Read,
}

fn start(conversations: &[String]) -> document::Eval {
    let source = include_str!("conversation_status_request.mjs")
        .replace("export async function", "async function");
    let script = format!("{source}\nconst input=await dioxus.recv();const c=new AbortController();let done=false;dioxus.recv().then(()=>{{if(!done)c.abort();}});try{{return await conversationStatusRequest({{...input,signal:c.signal}});}}finally{{done=true;c.abort();}}");
    let eval = document::eval(&script);
    let _ = eval.send(json!({"conversations":conversations}));
    eval
}

/// Reads badges for the listed conversations while mounted: again when the
/// live channel reports a change (every ten seconds without it).
#[component]
pub fn StatusPoll(
    ids: Vec<String>,
    session_scope: Signal<SessionScope>,
    mut statuses: Signal<BTreeMap<String, RowStatus>>,
    mut slots: Signal<Option<Slots>>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut mounted = use_signal(|| true);
    let mut channel = use_signal(|| None::<document::Eval>);
    use_drop(move || {
        mounted.set(false);
        if let Some(eval) = channel.peek().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    use_future(move || {
        let ids = ids.clone();
        async move {
            // The batch path the request reads (conversation_status_request.mjs).
            let path = format!("/api/v2/conversation-status?ids={}", ids.join(","));
            let mut since = None;
            loop {
                if ids.is_empty() {
                    return;
                }
                let eval = start(&ids);
                channel.set(Some(eval));
                let reply = eval.join::<Vec<Row>>().await;
                if !mounted() || !session_scope.read().is_current(owner) {
                    return;
                }
                channel.set(None);
                if let Ok(rows) = reply {
                    if rows.iter().any(|r| r.execution.status == 401) {
                        onexpired.call(());
                        return;
                    }
                    let mut next = BTreeMap::new();
                    for row in rows.iter().filter(|r| ids.contains(&r.id)) {
                        let execution = (row.execution.status == 200)
                            .then(|| {
                                serde_json::from_str::<ExecutionStatus>(&row.execution.text).ok()
                            })
                            .flatten()
                            .filter(|s| valid_execution(s, &row.id));
                        let queue = (row.queue.status == 200)
                            .then(|| {
                                serde_json::from_str::<ExecutionWindowQueue>(&row.queue.text).ok()
                            })
                            .flatten()
                            .filter(|q| valid_queue(q, &row.id));
                        if let Some(q) = queue.as_ref() {
                            slots.set(Some(Slots {
                                capacity: q.capacity,
                                active: q.active,
                                queued: q.queued_total,
                            }));
                        }
                        if let Some(status) = row_status(execution.as_ref(), queue.as_ref()) {
                            next.insert(row.id.clone(), status);
                        }
                    }
                    statuses.set(next);
                }
                since = Some(crate::live::wait(&path, since, 10_000).await.version);
                if !mounted() || !session_scope.read().is_current(owner) {
                    return;
                }
            }
        }
    });
    rsx! {}
}
