use dioxus::prelude::*;
use orkestr_v2_contracts::{ExecutionSteeringReceipt, ExecutionSteeringStatus};
use orkestr_v2_ui::{execution::Execution, session_scope::SessionScope, steering::Steering};
use serde_json::{json, Value};
#[component]
pub fn SteeringView(
    execution: Signal<Execution>,
    session_scope: Signal<SessionScope>,
    csrf: String,
    onexpired: EventHandler<()>,
    now_ms: u64,
) -> Element {
    let mut state = use_signal(Steering::default);
    let mut busy = use_signal(|| false);
    let mut channel = use_signal(|| None::<document::Eval>);
    let live = use_hook(|| std::rc::Rc::new(std::cell::Cell::new(true)));
    let dropped = live.clone();
    use_drop(move || {
        dropped.set(false);
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    let enabled = cfg!(feature = "execution-controls")
        && !busy()
        && !state.read().conflict
        && state.read().receipt.is_none()
        && execution.read().control_status().is_some_and(|s| {
            state.read().pending.is_some()
                || (execution.read().fresh(now_ms)
                    && s.capabilities.steer
                    && s.phase == orkestr_v2_contracts::ExecutionPhase::Running)
        });
    let field_id = format!(
        "steering-{}-{}",
        execution
            .read()
            .control_status()
            .map(|s| s.conversation_id.to_string())
            .unwrap_or_default(),
        execution
            .read()
            .control_status()
            .and_then(|s| s.run_id)
            .map(|r| r.to_string())
            .unwrap_or_default()
    );
    let delivery_live = live.clone();
    let delivery_csrf = csrf.clone();
    rsx! {
        section { "aria-label":"Steer running work",
            label { r#for:"{field_id}", "Instructions for running work" }
            textarea { id:"{field_id}", value:"{state.read().text}", oninput:move |e|state.write().text=e.value() }
            button { disabled:!enabled, onclick:move |_| {
                if !enabled {return;}
                let owner=session_scope.read().generation(); let selection=execution.read().selection_generation();
                let csrf=csrf.clone(); let live=live.clone(); busy.set(true);
                spawn(async move {
                    let result=async {
                        let key=crate::transport::key().await?;
                        if !live.get() || !session_scope.read().is_current(owner) || execution.read().selection_generation()!=selection {return Ok(());}
                        let current_ms=document::eval("return Math.floor(performance.now());").join::<u64>().await.map_err(|_|crate::transport::Failure::from("Refresh execution status".to_string()))?;
                        if !live.get() || !session_scope.read().is_current(owner) || execution.read().selection_generation()!=selection {return Ok(());}
                        if state.read().pending.is_none() && !execution.read().fresh(current_ms) {return Err(crate::transport::Failure::from("Refresh execution status".to_string()));}
                        let status=execution.read().control_status().ok_or_else(||crate::transport::Failure::from("Run unavailable".to_string()))?;
                        let pending=state.write().prepare(&status,key).map_err(|m|crate::transport::Failure::from(m.to_string()))?;
                        let eval=document::eval(include_str!("steering_request.js"));
                        eval.send(json!({"method":"POST","path":format!("/api/v2/conversations/{}/steer",status.conversation_id),"csrf":csrf,"body":pending})).map_err(|_|crate::transport::Failure::from("Steering not confirmed".to_string()))?;
                        channel.set(Some(eval)); let response=eval.join::<Value>().await;
                        if !live.get() || !session_scope.read().is_current(owner) || execution.read().selection_generation()!=selection{return Ok(());}
                        let response=response.map_err(|_|crate::transport::Failure::from("Steering not confirmed".to_string()))?;
                        let code=response["status"].as_u64().unwrap_or(0) as u16;
                        if code==401 || code==403 {onexpired.call(());return Ok(());}
                        if code!=200 {state.write().failed(code);return Ok(());}
                        let receipt=serde_json::from_value::<ExecutionSteeringReceipt>(response["body"].clone()).map_err(|_|crate::transport::Failure::from("Invalid steering receipt".to_string()))?;
                        if !state.write().receipt(&status.conversation_id,receipt){return Err(crate::transport::Failure::from("Invalid steering receipt".to_string()));}
                        Ok::<(),crate::transport::Failure>(())
                    }.await;
                    if live.get() && session_scope.read().is_current(owner) && execution.read().selection_generation()==selection {if result.is_err(){state.write().failed(0);} busy.set(false);channel.set(None);}
                });
            }, if busy(){"Requesting…"}else if state.read().pending.is_some(){"Retry original Steer"}else{"Steer"} }
            if state.read().conflict || state.read().receipt.is_some() {
                button {disabled:busy(),onclick:move |_|{let text=state.read().text.clone();state.set(Steering{text,..Default::default()});},"Review for a new request"}
            }
            if let Some(receipt)=state.read().receipt.clone() {
                button {disabled:busy(),onclick:move |_| {
                    if busy() {return;}
                    let owner=session_scope.read().generation();let selection=execution.read().selection_generation();let live=delivery_live.clone();let csrf=delivery_csrf.clone();let receipt=receipt.clone();busy.set(true);
                    spawn(async move {
                        let eval=document::eval(include_str!("steering_request.js"));
                        let result=async {
                            eval.send(json!({"method":"GET","path":format!("/api/v2/conversations/{}/steering/{}",receipt.conversation_id,receipt.request_key),"csrf":csrf})).map_err(|_|crate::transport::Failure::from("Status unavailable".to_string()))?;
                            channel.set(Some(eval));
                            let reply=eval.join::<Value>().await.map_err(|_|crate::transport::Failure::from("Status unavailable".to_string()))?;
                            if reply["status"]!=200 {return Err(crate::transport::Failure{status:reply["status"].as_u64().unwrap_or(0) as u16,message:"Status unavailable".into()});}
                            serde_json::from_value::<ExecutionSteeringStatus>(reply["body"].clone()).map_err(|_|crate::transport::Failure::from("Invalid status".to_string()))
                        }.await;
                        if live.get() && session_scope.read().is_current(owner) && execution.read().selection_generation()==selection {
                            match result {Ok(value)=>{if !state.write().delivery(value){state.write().notice="Delivery status unavailable.";}},Err(e)=>{if e.status==401 || e.status==403 {onexpired.call(());}else{state.write().notice="Delivery status unavailable; previous evidence retained.";}}} busy.set(false);
                        }
                    });
                },"Check delivery"}
            }
            p {role:"status","{state.read().notice}"}
            p {"Send queues ordinary work. A steering reservation is not delivery, and acknowledgement is not completion."}
        }
    }
}
