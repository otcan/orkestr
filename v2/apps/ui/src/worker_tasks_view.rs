use dioxus::prelude::*;
use orkestr_v2_contracts::{ConversationId, RunId, WorkerTaskPhase, WorkerTaskReceipt};
use orkestr_v2_ui::{
    session_scope::SessionScope,
    worker_tasks::{phase_label, TaskDraft, TaskHistory},
};
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc};

/// Mounted by the canonical parent read controller after the HTTP contract handoff.
#[component]
pub fn WorkerTasksView(
    conversation: ConversationId,
    parent: RunId,
    control_revision: i64,
    can_create: bool,
    session_scope: Signal<SessionScope>,
    csrf: String,
    mut history: Signal<TaskHistory>,
    onrefresh: EventHandler<()>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut draft = use_signal(TaskDraft::default);
    let mut selected_run = use_signal(String::new);
    let worker_execution = use_signal(orkestr_v2_ui::execution::Execution::default);
    let mut busy = use_signal(|| false);
    let mut notice = use_signal(String::new);
    let mut channel = use_signal(|| None::<document::Eval>);
    let active = use_hook(|| Rc::new(Cell::new(true)));
    let dropped = active.clone();
    use_drop(move || {
        dropped.set(false);
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    let creating = can_create || draft.read().retryable();
    rsx! {
        section { "aria-label": "Worker tasks",
            h3 { "Worker tasks" }
            p { "Write instructions for a separate worker task. The parent conversation is not copied." }
            details { summary { "Parent run details" } p { "{parent}" } }
            p { "Queued tasks are waiting. A claimed task may not have started yet. Review and accept a worker’s result before it is marked completed." }
            label { "Task title", input { value: "{draft.read().title}", oninput: move |event| { let instructions=draft.read().instructions.clone();draft.write().edit(event.value(),instructions); } } }
            label { "Independent task instructions", textarea { value: "{draft.read().instructions}", oninput: move |event| { let title=draft.read().title.clone();draft.write().edit(title,event.value()); } } }
            p { "Title: up to 160 UTF-8 bytes. Instructions: up to 16384 bytes. Task claim lifetime: 30 seconds." }
            if !can_create { p { "New tasks are unavailable for this parent. Existing tasks remain visible; uncertain requests can be retried unchanged." } }
            button { disabled: busy() || !creating || draft.read().needs_review(), onclick: {
                let conversation=conversation.clone();let parent=parent.clone();let csrf=csrf.clone();
                move |_| {
                    let active = active.clone();
                    if busy() || !creating || draft.read().needs_review() { return; }
                    let conversation=conversation.clone();let parent=parent.clone();let csrf=csrf.clone();
                    let owner=session_scope.read().generation();busy.set(true);
                    spawn(async move {
                        let result=async {
                            let key=crate::transport::key().await?;
                            if !active.get() || !session_scope.read().is_current(owner) { return Ok(()); }
                            let pending=draft.write().prepare(conversation,parent,control_revision,can_create,key).map_err(|m|crate::transport::Failure::from(m.to_string()))?;
                            let eval=document::eval(include_str!("worker_task_request.js"));
                            eval.send(json!({"method":"POST","path":format!("/api/v2/conversations/{}/worker-tasks",pending.conversation),"csrf":csrf,"body":pending.request})).map_err(|_|crate::transport::Failure::from("Task request not confirmed".to_string()))?;
                            channel.set(Some(eval));let response=eval.join::<Value>().await;
                            if !active.get() || !session_scope.read().is_current(owner) { return Ok(()); }
                            let response=match response { Ok(response)=>response,Err(_)=>{draft.write().failed(&pending,0);return Ok(());} };
                            let code=response["status"].as_u64().unwrap_or(0) as u16;
                            if code==401 || code==403 { onexpired.call(());return Ok(()); }
                            if code==200 {
                                let receipt=serde_json::from_value::<WorkerTaskReceipt>(response["body"].clone());
                                if receipt.ok().is_none_or(|receipt|draft.write().receipt(&pending,receipt).is_err()) { draft.write().failed(&pending,0); }
                                onrefresh.call(());
                            } else { draft.write().failed(&pending,code); }
                            Ok::<(),crate::transport::Failure>(())
                        }.await;
                        if active.get() && session_scope.read().is_current(owner) {
                            if let Err(error)=result { notice.set(error.message); }
                            busy.set(false);channel.set(None);
                        }
                    });
                }
            }, if busy() { "Saving task…" } else if draft.read().retryable() { "Retry original task" } else { "Create worker task" } }
            if draft.read().needs_review() {
                button { disabled: busy(), onclick: move |_| { draft.write().review();onrefresh.call(()); }, "Review parent and prepare next task" }
            }
            if let Some(message)=draft.read().notice() { p { role:"status", "{message}" } }
            p { role:"status", "{notice}" }
            button { onclick: move |_| onrefresh.call(()), "Refresh worker task history" }
            if let Some(list)=history.read().list() {
                ol {
                    for row in &list.tasks {
                        li { key: "{row.task.task_id}",
                            h4 { "{row.title.as_deref().unwrap_or(\"Task payload removed\")}" }
                            p { "{phase_label(row.phase)}" }
                            p { if row.instructions_available { "Instructions saved. This history shows the task title; instruction text is not included." } else { "Saved instructions removed." } }
                            if let Some(run) = &row.run_id {
                                button { onclick: { let run=run.to_string(); move |_| selected_run.set(run.clone()) }, "View worker activity" }
                            }
                            details { summary { "Task provenance" }
                            p { "Task {row.task.task_id} · Parent {row.task.parent_run_id}" }
                            p { "Source message {row.task.source_message_id} · Source event {row.task.source_event_id}" }
                            if let Some(run)=&row.run_id { p { "Linked worker run: {run}" } }
                            }
                            WorkerTaskAction { key:"hold-{row.task.task_id}", conversation: conversation.clone(), task:row.task.task_id.to_string(), csrf:csrf.clone(), session_scope, history, onrefresh, onexpired,
                                remove:false, enabled:matches!(row.phase,WorkerTaskPhase::Queued|WorkerTaskPhase::Claimed) }
                            WorkerTaskAction { key:"delete-{row.task.task_id}", conversation: conversation.clone(), task:row.task.task_id.to_string(), csrf:csrf.clone(), session_scope, history, onrefresh, onexpired,
                                remove:true, enabled:row.instructions_available }
                        }
                    }
                }
            } else { p { "Task history has not been loaded for this parent." } }
            if !selected_run().is_empty() && history.read().list().is_some_and(|list| list.tasks.iter().any(|row| row.run_id.as_ref().is_some_and(|run| run.to_string()==selected_run()))) {
                crate::execution_poll::ExecutionPoll { key:"{selected_run()}", id:conversation.to_string(), run:selected_run(), csrf:csrf.clone(), session_scope, execution:worker_execution, onexpired }
            }
        }
    }
}

#[component]
fn WorkerTaskAction(
    conversation: ConversationId,
    task: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    mut history: Signal<TaskHistory>,
    onrefresh: EventHandler<()>,
    onexpired: EventHandler<()>,
    remove: bool,
    enabled: bool,
) -> Element {
    let mut busy = use_signal(|| false);
    let mut notice = use_signal(String::new);
    let mut channel = use_signal(|| None::<document::Eval>);
    let active = use_hook(|| Rc::new(Cell::new(true)));
    let dropped = active.clone();
    use_drop(move || {
        dropped.set(false);
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    rsx! {
        button { disabled:busy()||!enabled, title:if remove { "Remove saved task title and instructions; retain task history" } else { "Hold pending intent. Running work requires Stop in worker activity." }, onclick:move |_| {
            let active = active.clone();
            if busy()||!enabled{return;}
            let owner=session_scope.read().generation();let task=task.clone();let conversation=conversation.clone();let csrf=csrf.clone();busy.set(true);
            spawn(async move {
                let eval=document::eval(include_str!("worker_task_request.js"));
                let path=format!("/api/v2/conversations/{conversation}/worker-tasks/{task}/{}",if remove{"payload"}else{"hold"});
                let sent=eval.send(json!({"method":if remove{"DELETE"}else{"POST"},"path":path,"csrf":csrf,"body":{}}));
                channel.set(Some(eval));
                let response=if sent.is_ok(){eval.join::<Value>().await.ok()}else{None};
                if !active.get() || !session_scope.read().is_current(owner){return;}
                let code=response.as_ref().and_then(|r|r["status"].as_u64()).unwrap_or(0);
                if code==401||code==403 {onexpired.call(());return;}
                if code==204 {
                    if remove {if let Ok(task)=serde_json::from_value(json!(task)){history.write().removed(&task);}}
                    notice.set(if remove{"Task payload removed; history retained."}else{"Hold saved. Refreshing current task state."}.into());onrefresh.call(());
                } else {notice.set(match code {409=>"Task state changed. Refresh before retrying; running work requires Stop.",404=>"Task is unavailable for this conversation.",_=>"Operation not confirmed. Refresh or retry the same task."}.into());}
                busy.set(false);channel.set(None);
            });
        }, if remove {"Remove task payload"}else{"Hold task"} }
        p {role:"status","{notice}"}
    }
}
