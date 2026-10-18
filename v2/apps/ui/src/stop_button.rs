use dioxus::prelude::*;
use orkestr_v2_contracts::ExecutionStopReceipt;
use orkestr_v2_ui::{execution::Execution, session_scope::SessionScope};
use serde_json::{json, Value};

// Default activation remains off until exact route/composition verification is accepted.
const STOP_ACTIVATED: bool = false;
#[component]
pub fn StopButton(
    mut execution: Signal<Execution>,
    session_scope: Signal<SessionScope>,
    csrf: String,
    onexpired: EventHandler<()>,
) -> Element {
    let mut busy = use_signal(|| false);
    let mut channel = use_signal(|| None::<document::Eval>);
    use_drop(move || {
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    let status = execution.read().control_status();
    let enabled = STOP_ACTIVATED
        && !busy()
        && status.as_ref().is_some_and(|s| {
            !execution.read().stops.accepted(s)
                && (execution.read().can_stop(0) || execution.read().stops.retryable(s))
        });
    let notice = status
        .as_ref()
        .and_then(|s| execution.read().stops.notice(s));
    rsx! {
        button { r#type: "button", disabled: !enabled, title: if STOP_ACTIVATED { "Request provider stop" } else { "Stop is not available on this server yet" }, onclick: move |_| {
            if !enabled || busy() { return; }
            let csrf = csrf.clone();
            let owner = session_scope.read().generation();
            let selection = execution.read().selection_generation();
            busy.set(true);
            spawn(async move {
                let result = async {
                    let key = crate::transport::key().await?;
                    if !session_scope.read().is_current(owner) || execution.read().selection_generation()!=selection { return Ok(()); }
                    let status = execution.read().control_status().ok_or_else(|| crate::transport::Failure::from("Execution unavailable".to_string()))?;
                    let pending = execution.write().stops.prepare(&status,key).map_err(|m|crate::transport::Failure::from(m.to_string()))?;
                    let eval = document::eval(include_str!("stop_request.js"));
                    eval.send(json!({"path":format!("/api/v2/conversations/{}/stop",pending.conversation),"csrf":csrf,"body":pending.request})).map_err(|_|crate::transport::Failure::from("Stop not confirmed".to_string()))?;
                    channel.set(Some(eval));
                    let response = eval.join::<Value>().await;
                    if !session_scope.read().is_current(owner) || execution.read().selection_generation()!=selection { return Ok(()); }
                    let response = match response { Ok(value)=>value, Err(_)=> { execution.write().stops.failed(&pending,0);return Ok(()); } };
                    let code = response["status"].as_u64().unwrap_or(0) as u16;
                    if code==401 || code==403 { execution.write().authorization_lost();onexpired.call(());return Ok(()); }
                    if code==200 {
                        let receipt=serde_json::from_value::<ExecutionStopReceipt>(response["body"].clone());
                        if receipt.ok().is_none_or(|r|execution.write().stops.receipt(&pending,r).is_err()) { execution.write().stops.failed(&pending,0); }
                    } else { execution.write().stops.failed(&pending,code); }
                    Ok::<(),crate::transport::Failure>(())
                }.await;
                if session_scope.read().is_current(owner) && execution.read().selection_generation()==selection {
                    if result.is_err() { execution.write().control_failed(); }
                    busy.set(false);channel.set(None);
                }
            });
        }, if !STOP_ACTIVATED { "Stop unavailable" } else if busy() { "Requesting stop…" } else { "Stop" } }
        if let Some(notice)=notice { p { role:"status", "{notice}" } }
    }
}
