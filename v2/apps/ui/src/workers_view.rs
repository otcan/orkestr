use dioxus::prelude::*;
use orkestr_v2_contracts::{ConversationId, RunId, WorkerExecutionPage};
use orkestr_v2_ui::{
    execution::Execution,
    session_scope::SessionScope,
    workers::{recovery_label, Workers},
};
use serde_json::{json, Value};

#[component]
pub fn WorkersView(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    workers: Signal<Workers>,
    execution: Signal<Execution>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut after = use_signal(String::new);
    rsx! {
        section { "aria-label": "Workers",
            h2 { "Workers" }
            p { "Independent workers for this conversation. Recovery status does not confirm that a worker can resume." }
            button { disabled: after().is_empty(), onclick: move |_| after.set(String::new()), "First workers" }
            WorkerPage { key: "{id}-{after()}", id, after: after(), csrf, session_scope, workers, execution, onexpired, onnext: move |cursor| after.set(cursor) }
        }
    }
}

#[component]
fn WorkerPage(
    id: String,
    after: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    mut workers: Signal<Workers>,
    execution: Signal<Execution>,
    onexpired: EventHandler<()>,
    onnext: EventHandler<String>,
) -> Element {
    let owner = session_scope.read().generation();
    let conversation = serde_json::from_value::<ConversationId>(json!(id)).ok();
    let cursor = if after.is_empty() {
        None
    } else {
        serde_json::from_value::<RunId>(json!(after)).ok()
    };
    let read = use_hook(move || conversation.map(|id| workers.write().begin(id, cursor)));
    let mut now = use_signal(|| 0u64);
    let path_id = id.clone();
    let channel = use_hook(move || {
        let channel = document::eval(include_str!("execution_poll.js"));
        let query = if after.is_empty() {
            "limit=25".into()
        } else {
            format!("after={after}&limit=25")
        };
        let _ = channel
            .send(json!({"path":format!("/api/v2/conversations/{path_id}/workers?{query}")}));
        channel
    });
    use_drop(move || {
        let _ = channel.send(json!({"stop":true}));
    });
    use_future(move || {
        let read = read.clone();
        async move {
            let mut channel = channel;
            let Some(read) = read else {
                let _ = channel.send(json!({"stop":true}));
                return;
            };
            while let Ok(message) = channel.recv::<Value>().await {
                if !session_scope.read().is_current(owner) {
                    let _ = channel.send(json!({"stop":true}));
                    return;
                }
                let Some(received) = message["now"].as_u64() else {
                    continue;
                };
                now.set(received);
                match message["kind"].as_str() {
                    Some("tick") => {}
                    Some("response") if message["status"].as_u64() == Some(200) => {
                        let page =
                            serde_json::from_value::<WorkerExecutionPage>(message["body"].clone());
                        if page.ok().is_none_or(|page| {
                            workers.write().apply(&read, received, page).is_err()
                        }) {
                            workers.write().failed(&read);
                        }
                    }
                    Some("response") if matches!(message["status"].as_u64(), Some(401 | 403)) => {
                        let _ = channel.send(json!({"stop":true}));
                        onexpired.call(());
                        return;
                    }
                    _ => workers.write().failed(&read),
                }
            }
            workers.write().failed(&read);
        }
    });
    let model = workers.read();
    let selected = model.selected().map(ToString::to_string);
    rsx! {
        p { role: "status", "{model.notice(now())}" }
        if let Some(page) = model.displayed_page() {
            ul {
                for worker in &page.workers {
                    li { key: "{worker.run_id}",
                        p { "Worker {worker.run_id} · {worker.state:?}" }
                        p { "{recovery_label(worker.recovery)}" }
                        p { "Parent run: {worker.parent_run_id} · Source message: {worker.source_message_id}" }
                        button { onclick: { let run = worker.run_id.clone(); move |_| { workers.write().select(&run); } }, "View worker activity" }
                    }
                }
            }
            if let Some(cursor) = &page.next_after {
                button { onclick: { let cursor = cursor.to_string(); move |_| onnext.call(cursor.clone()) }, "Next workers" }
            }
        }
        if let Some(run) = selected {
            crate::execution_poll::ExecutionPoll { key: "{run}", id, run, csrf, session_scope, execution, onexpired }
        }
    }
}
