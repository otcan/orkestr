use dioxus::prelude::*;
use orkestr_v2_contracts::{ConversationId, ExecutionStatus, RunId, WorkerTaskList};
use orkestr_v2_ui::{session_scope::SessionScope, worker_tasks::TaskHistory};
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc};

#[component]
pub fn WorkerTasksPanel(
    conversation: ConversationId,
    parent: RunId,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    #[props(default = true)] allow_create: bool,
) -> Element {
    let history = use_signal(TaskHistory::default);
    let control = use_signal(|| None::<i64>);
    let ready = use_signal(|| false);
    let mut refresh = use_signal(|| 0u64);
    rsx! {
        div { key: "{refresh()}", TaskRead { conversation: conversation.clone(), parent: parent.clone(), session_scope, onexpired, history, control, ready, status_read: false }
        TaskRead { conversation: conversation.clone(), parent: parent.clone(), session_scope, onexpired, history, control, ready, status_read: true } }
        crate::worker_tasks_view::WorkerTasksView {
            conversation, parent, control_revision: control().unwrap_or(0),
            can_create: allow_create && ready() && control().is_some() && history.read().list().is_some_and(|list| list.can_create),
            csrf, session_scope, history, onexpired, onrefresh: move |_| refresh += 1
        }
    }
}

/// Separate serialized, bounded channels; a remount retires every old callback.
#[component]
fn TaskRead(
    conversation: ConversationId,
    parent: RunId,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    mut history: Signal<TaskHistory>,
    mut control: Signal<Option<i64>>,
    mut ready: Signal<bool>,
    status_read: bool,
) -> Element {
    let owner = session_scope.read().generation();
    let active = use_hook(|| Rc::new(Cell::new(true)));
    let dropped = active.clone();
    let mut notice = use_signal(|| "Loading worker task information…");
    let path = if status_read {
        format!("/api/v2/conversations/{conversation}/execution?run_id={parent}")
    } else {
        format!("/api/v2/conversations/{conversation}/worker-tasks?parent_run_id={parent}")
    };
    let channel = use_hook(move || {
        if status_read {
            control.set(None);
        } else {
            ready.set(false);
        }
        let eval = document::eval(include_str!("execution_poll.js"));
        let _ = eval.send(json!({"path":path}));
        eval
    });
    use_drop(move || {
        dropped.set(false);
        let _ = channel.send(json!({"stop":true}));
    });
    use_future(move || {
        let active = active.clone();
        let conversation = conversation.clone();
        let parent = parent.clone();
        async move {
            let mut channel = channel;
            while let Ok(message) = channel.recv::<Value>().await {
                if !active.get() || !session_scope.read().is_current(owner) {
                    let _ = channel.send(json!({"stop":true}));
                    return;
                }
                if message["kind"] == "tick" {
                    continue;
                }
                let code = message["status"].as_u64().unwrap_or(0);
                if code == 401 || code == 403 {
                    let _ = channel.send(json!({"stop":true}));
                    onexpired.call(());
                    return;
                }
                let valid = if code != 200 {
                    false
                } else if status_read {
                    serde_json::from_value::<ExecutionStatus>(message["body"].clone())
                        .ok()
                        .is_some_and(|status| {
                            if !status.is_valid()
                                || status.conversation_id != conversation
                                || status.run_id.as_ref() != Some(&parent)
                            {
                                return false;
                            }
                            control.set(status.control_revision);
                            true
                        })
                } else {
                    serde_json::from_value::<WorkerTaskList>(message["body"].clone())
                        .ok()
                        .is_some_and(|list| {
                            history.write().apply(&conversation, &parent, list).is_ok()
                        })
                };
                if status_read {
                    if !valid {
                        control.set(None);
                    }
                } else {
                    ready.set(valid);
                }
                notice.set(if valid {
                    if status_read {
                        "Parent activity checked."
                    } else {
                        "Worker task history updated."
                    }
                } else {
                    "Worker task information unavailable. Refresh or reconnect."
                });
            }
            if active.get() && session_scope.read().is_current(owner) {
                if status_read {
                    control.set(None);
                } else {
                    ready.set(false);
                }
                notice.set("Worker task connection interrupted.");
            }
        }
    });
    rsx! { p { role: "status", "{notice}" } }
}
