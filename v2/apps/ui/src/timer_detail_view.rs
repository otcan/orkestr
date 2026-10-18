use dioxus::prelude::*;
use orkestr_v2_contracts::ConversationId;
use orkestr_v2_ui::{
    session_scope::SessionScope,
    timer_labels::{controller_notice, held_reason, schedule_label, state_label, utc_time},
    timers::{Action, Detail, Editor, State},
};
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc};

#[component]
pub fn TimerDetail(
    mut detail: Signal<Option<Detail>>,
    mut fresh: Signal<bool>,
    mut epoch: Signal<u64>,
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut editor = use_signal(Editor::default);
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
    let submit = Callback::new(move |action: Option<Action>| {
        if busy() || !cfg!(feature = "execution-controls") {
            return;
        }
        let Some(current) = detail() else {
            return;
        };
        if !fresh() && editor.read().pending().is_none() {
            return;
        }
        let target = serde_json::from_value::<ConversationId>(json!(conversation)).ok();
        let Some(target) = target else {
            return;
        };
        let active = active.clone();
        let csrf = csrf.clone();
        let owner = session_scope.read().generation();
        busy.set(true);
        spawn(async move {
            let result=async {
                let key=crate::transport::key().await?;
                if !active.get()||!session_scope.read().is_current(owner){return Ok(());}
                let pending=editor.write().prepare(&current,&target,action,key).map_err(|m|crate::transport::Failure::from(m.to_string()))?;
                let eval=document::eval(include_str!("timer_request.js"));
                eval.send(json!({"method":"POST","path":format!("/api/v2/timers/{}/{}",pending.namespace,pending.operation),"csrf":csrf,"body":pending.body})).map_err(|_|crate::transport::Failure::from("Timer request not confirmed.".to_string()))?;
                channel.set(Some(eval));let response=eval.join::<Value>().await.ok();
                if !active.get()||!session_scope.read().is_current(owner){return Ok(());}
                let code=response.as_ref().and_then(|r|r["status"].as_u64()).unwrap_or(0) as u16;
                if code==401||code==403 {onexpired.call(());return Ok(());}
                let next=response.and_then(|r|serde_json::from_value::<Detail>(r["body"].clone()).ok());
                let confirmed=editor.write().result(&pending,code,next.as_ref()).is_ok();
                if confirmed {
                    fresh.set(false);
                    epoch+=1;
                    if let Some(next)=next.filter(|next|detail.read().as_ref().is_none_or(|old|next.revision>=old.revision)){detail.set(Some(next));}
                }
                Ok::<(),crate::transport::Failure>(())
            }.await;
            if active.get() && session_scope.read().is_current(owner) {
                if let Err(error) = result {
                    notice.set(error.message);
                }
                busy.set(false);
                channel.set(None);
            }
        });
    });
    let disabled = busy()
        || !fresh()
        || editor.read().pending().is_some()
        || !cfg!(feature = "execution-controls");
    rsx! {
        section {"aria-label":"Timer details", h3 {"Timer details"}
            if let Some(current)=detail() {
                p {role:"status","{state_label(current.state.as_str())}"}
                p {"{schedule_label(&current.schedule)}"}
                if let Some(due)=current.next_due_ms {p {"Next scheduled time: {utc_time(due)}"}} else {p {"No next scheduled time supplied."}}
                if let Some(reason)=held_reason(current.dormant_reason.as_deref()){p {"{reason}"}}
                p {"{controller_notice(current.state.as_str(),current.controller_armed)}"}
                p {"Scheduling permission lasts at most one hour and is not kept across server restarts."}
                label {r#for:"timer-owner-text","Fresh instructions for the selected conversation"}
                textarea {id:"timer-owner-text",value:"{editor.read().text}",oninput:move |event|editor.write().edit(event.value())}
                p {"Imported instructions are not copied. Changing this text does not change an uncertain request."}
                button {disabled:disabled||current.dormant_reason.is_some()||matches!(current.state,State::Enabled|State::Stopped|State::RolledBack),onclick:move |_|submit.call(None),"Enable timer"}
                for (action,label) in [(Action::Disable,"Disable timer"),(Action::Stop,"Stop timer schedule"),(Action::Rollback,"Roll back timer schedule")] {
                    button {disabled,onclick:move |_|submit.call(Some(action)),"{label}"}
                }
                p {"These controls change the schedule. They do not confirm interruption of work already started."}
                if editor.read().pending().is_some()&&!editor.read().needs_review(){button {disabled:busy()||!cfg!(feature="execution-controls"),onclick:move |_|submit.call(None),"Retry original timer request"}}
                if editor.read().needs_review(){button {disabled:busy(),onclick:move |_|{editor.write().review();fresh.set(false);epoch+=1;},"Review current timer before next change"}}
                if !cfg!(feature="execution-controls"){p {"Timer changes are unavailable in this build."}}
                if let Some(message)=editor.read().notice{p {role:"status","{message}"}}
                details {summary {"Timer provenance"}p {"{current.namespace}"}p {"Source: {current.source_digest}"}p {"Revision {current.revision}; generation {current.generation}"}}
            }
            p {role:"status","{notice}"}
        }
    }
}
