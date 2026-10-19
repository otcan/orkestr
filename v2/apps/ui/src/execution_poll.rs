use dioxus::prelude::*;
use orkestr_v2_contracts::ExecutionStatus;
use orkestr_v2_ui::{execution::Execution, session_scope::SessionScope};
use serde_json::{json, Value};

#[component]
pub fn ExecutionPoll(
    id: String,
    #[props(default)] run: String,
    #[props(default)] fast: bool,
    #[props(default = true)] worker_tasks: bool,
    csrf: String,
    session_scope: Signal<SessionScope>,
    mut execution: Signal<Execution>,
    onexpired: EventHandler<()>,
) -> Element {
    let parent_tasks = worker_tasks && run.is_empty() && !fast;
    let generation = session_scope.read().generation();
    let selected = id.clone();
    let selected_run = run.clone();
    let selection_generation = use_hook(move || execution.write().select(&selected, &selected_run));
    let mut now = use_signal(|| 0u64);
    let channel = use_hook(move || {
        let eval = document::eval(include_str!("execution_poll.js"));
        let path = if fast {
            if run.is_empty() {
                format!("/api/v2/conversations/{id}/fast/execution")
            } else {
                format!("/api/v2/conversations/{id}/fast/execution?run_id={run}")
            }
        } else if run.is_empty() {
            format!("/api/v2/conversations/{id}/execution")
        } else {
            format!("/api/v2/conversations/{id}/execution?run_id={run}")
        };
        let _ = eval.send(json!({"path":path}));
        eval
    });
    use_drop(move || {
        let _ = channel.send(json!({"stop":true}));
    });
    use_future(move || async move {
        let mut channel = channel;
        while let Ok(message) = channel.recv::<Value>().await {
            if !session_scope.read().is_current(generation) {
                let _ = channel.send(json!({"stop":true}));
                return;
            }
            if execution.read().selection_generation() != selection_generation {
                let _ = channel.send(json!({"stop":true}));
                return;
            }
            let Some(received) = message["now"].as_u64() else {
                continue;
            };
            now.set(received);
            match message["kind"].as_str() {
                Some("tick") => {}
                Some("response") => match message["status"].as_u64() {
                    Some(200) => {
                        let status =
                            serde_json::from_value::<ExecutionStatus>(message["body"].clone());
                        if status.ok().is_none_or(|status| {
                            execution
                                .write()
                                .apply_status(selection_generation, received, status)
                                .is_err()
                        }) {
                            execution.write().disconnected();
                        }
                    }
                    Some(204) => {
                        execution.write().absent(selection_generation);
                    }
                    Some(401 | 403) => {
                        execution.write().authorization_lost();
                        let _ = channel.send(json!({"stop":true}));
                        onexpired.call(());
                        return;
                    }
                    _ => execution.write().disconnected(),
                },
                _ => execution.write().disconnected(),
            }
        }
        let _ = channel.send(json!({"stop":true}));
        if execution.read().selection_generation() == selection_generation {
            execution.write().disconnected();
        }
    });
    if fast {
        rsx! { crate::fast_panel::FastPanel { execution, now_ms: now(), csrf, session_scope, onexpired } }
    } else {
        rsx! { crate::execution_panel::ExecutionPanel { execution, now_ms: now(), csrf, session_scope, onexpired, parent_tasks } }
    }
}
