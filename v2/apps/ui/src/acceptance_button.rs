use dioxus::prelude::*;
use orkestr_v2_contracts::ExecutionAcceptanceReceipt;
use orkestr_v2_ui::{execution::Execution, session_scope::SessionScope};
use serde_json::{json, Value};

// Enabled only in a registered matching server candidate.
const ACCEPTANCE_ACTIVATED: bool = cfg!(feature = "execution-controls");
#[component]
pub fn AcceptanceButton(
    mut execution: Signal<Execution>,
    session_scope: Signal<SessionScope>,
    csrf: String,
    now_ms: u64,
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
    let enabled = ACCEPTANCE_ACTIVATED
        && !busy()
        && status.as_ref().is_some_and(|s| {
            (execution.read().fresh(now_ms) || execution.read().acceptances.retryable(s))
                && execution.read().acceptances.available(s)
        });
    let review_hint = status
        .as_ref()
        .filter(|s| s.phase == orkestr_v2_contracts::ExecutionPhase::AwaitingAcceptance)
        .map(|s| {
            if !execution.read().acceptances.available(s) {
                "Completion details unavailable. Reconnect to refresh."
            } else if !execution.read().fresh(now_ms) && !execution.read().acceptances.retryable(s)
            {
                "Execution status is stale. Reconnect before accepting."
            } else {
                "Review the provider output before accepting this completion."
            }
        });
    let mut notice = use_signal(|| None::<String>);
    let status_notice = status
        .as_ref()
        .and_then(|s| execution.read().acceptances.notice(s));
    rsx! {
        button { r#type: "button", disabled: !enabled, title: if ACCEPTANCE_ACTIVATED { "Accept this completion" } else { "Completion acceptance is not available on this server yet" }, onclick: move |_| {
            if !enabled || busy() { return; }
            let csrf = csrf.clone();
            let owner = session_scope.read().generation();
            let selection = execution.read().selection_generation();
            busy.set(true);
            spawn(async move {
                let result = async {
                    let key = crate::transport::key().await?;
                    if !session_scope.read().is_current(owner) || execution.read().selection_generation()!=selection { return Ok(()); }
                    let current_ms = document::eval("return Math.floor(performance.now());").join::<u64>().await.map_err(|_|crate::transport::Failure::from("Refresh execution before accepting.".to_string()))?;
                    if !session_scope.read().is_current(owner) || execution.read().selection_generation()!=selection { return Ok(()); }
                    let status = execution.read().control_status().ok_or_else(|| crate::transport::Failure::from("Execution unavailable".to_string()))?;
                    if !execution.read().fresh(current_ms) && !execution.read().acceptances.retryable(&status) { return Err(crate::transport::Failure::from("Refresh execution before accepting.".to_string())); }
                    let pending = execution.write().acceptances.prepare(&status,key).map_err(|m|crate::transport::Failure::from(m.to_string()))?;
                    let eval = document::eval(include_str!("acceptance_request.js"));
                    eval.send(json!({"path":format!("/api/v2/conversations/{}/accept",pending.conversation),"csrf":csrf,"body":pending.request})).map_err(|_|crate::transport::Failure::from("Acceptance not confirmed".to_string()))?;
                    channel.set(Some(eval));
                    let response = eval.join::<Value>().await;
                    if !session_scope.read().is_current(owner) || execution.read().selection_generation()!=selection { return Ok(()); }
                    let response = match response { Ok(value)=>value, Err(_)=> { execution.write().acceptances.failed(&pending,0);return Ok(()); } };
                    let code = response["status"].as_u64().unwrap_or(0) as u16;
                    if code==401 || code==403 { execution.write().authorization_lost();onexpired.call(());return Ok(()); }
                    if code==200 {
                        let receipt=serde_json::from_value::<ExecutionAcceptanceReceipt>(response["body"].clone());
                        if receipt.ok().is_none_or(|r|execution.write().acceptances.receipt(&pending,r).is_err()) { execution.write().acceptances.failed(&pending,0); }
                    } else { execution.write().acceptances.failed(&pending,code); }
                    Ok::<(),crate::transport::Failure>(())
                }.await;
                if session_scope.read().is_current(owner) && execution.read().selection_generation()==selection {
                    if result.is_err() { notice.set(Some("Acceptance not confirmed. Refresh and retry.".to_string())); }
                    busy.set(false);channel.set(None);
                }
            });
        }, if !ACCEPTANCE_ACTIVATED { "Accept completion unavailable" } else if busy() { "Accepting…" } else { "Accept completion" } }
        if let Some(message)=review_hint { p { "{message}" } }
        if ACCEPTANCE_ACTIVATED && status.as_ref().is_some_and(|s| execution.read().acceptances.can_review_updated(s)) {
            button { r#type:"button", disabled:busy() || !execution.read().fresh(now_ms), onclick:move |_| {
                if busy() || !execution.read().fresh(now_ms) { return; }
                let current = execution.read().control_status();
                if let Some(status)=current { let _=execution.write().acceptances.review_updated(&status); }
            }, "Review updated completion" }
        }
        if let Some(message)=status_notice { p { role:"status", "{message}" } }
        if let Some(message)=notice() { p { role:"status", "{message}" } }
    }
}
