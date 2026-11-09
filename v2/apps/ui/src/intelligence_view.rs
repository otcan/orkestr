use dioxus::prelude::*;
use orkestr_v2_contracts::ExecutionPhase;
use orkestr_v2_ui::{
    execution::Execution, intelligence::IntelligenceCapabilities, session_scope::SessionScope,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Reply {
    status: u16,
    text: String,
}

#[component]
pub fn IntelligencePanel(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    execution: Signal<Execution>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut capabilities = use_signal(|| None::<IntelligenceCapabilities>);
    let mut notice = use_signal(|| "Checking agent capabilities…".to_string());
    let mut channel = use_signal(|| None::<document::Eval>);
    let mut mounted = use_signal(|| true);
    use_drop(move || {
        mounted.set(false);
        if let Some(channel) = channel.peek().as_ref() {
            let _ = channel.send(json!({"stop":true}));
        }
    });
    let read_id = id.clone();
    use_future(move || {
        let id = read_id.clone();
        async move {
            loop {
                if !mounted() || !session_scope.read().is_current(owner) {
                    return;
                }
                let source = include_str!("intelligence_request.mjs")
                    .replace("export async function", "async function");
                let script=format!("{source}\nconst input=await dioxus.recv();const c=new AbortController();let done=false;dioxus.recv().then(()=>{{if(!done)c.abort();}});try{{return await intelligenceRequest({{...input,signal:c.signal}});}}finally{{done=true;c.abort();}}");
                let eval = document::eval(&script);
                let _ = eval.send(json!({"conversation":id}));
                channel.set(Some(eval));
                let reply = eval.join::<Reply>().await;
                if !mounted() || !session_scope.read().is_current(owner) {
                    return;
                }
                channel.set(None);
                match reply {
                    Ok(reply) if reply.status == 401 || reply.status == 403 => {
                        capabilities.set(None);
                        onexpired.call(());
                        return;
                    }
                    Ok(reply) if reply.status == 200 => {
                        match serde_json::from_str::<IntelligenceCapabilities>(&reply.text) {
                            Ok(value) if value.valid(&id) => {
                                capabilities.set(Some(value));
                                notice.set(String::new());
                            }
                            _ => {
                                capabilities.set(None);
                                notice.set("Agent capabilities could not be verified.".into());
                            }
                        }
                    }
                    _ => {
                        capabilities.set(None);
                        notice.set(
                            "Agent capabilities unavailable. Existing work is unchanged.".into(),
                        );
                    }
                }
                crate::transport::delay().await;
            }
        }
    });
    let parent = execution
        .read()
        .control_status()
        .filter(|s| s.conversation_id.to_string() == id);
    rsx! { section { class:"intelligence-layers", "aria-label":"Agent and workers",
        if let Some(caps)=capabilities() {
            div { class:"intelligence-summary",
                span { class:"deep-label", strong {"Agent"} " · {caps.deep.label()}" }
                span { "Workers · {caps.worker.label()}" }
            }
            div { class:"intelligence-tools",
                details { class:"intelligence-layer",
                    summary { "Worker tasks" }
                    p { "Delegate an independent task while the agent is running. Workers share the remaining work limits." }
                    if caps.worker.configured {
                        if let Some(parent)=parent.as_ref() {
                            if let Some(run)=parent.run_id.as_ref() {
                                crate::worker_tasks_panel::WorkerTasksPanel {
                                    key:"workers-{id}-{run}-{owner}", conversation:parent.conversation_id.clone(), parent:run.clone(),
                                    csrf:csrf.clone(), session_scope, onexpired,
                                    allow_create:caps.worker.available && parent.phase==ExecutionPhase::Running,
                                }
                            } else { p {"Start work before creating a worker task."} }
                        } else { p { "Start work before creating a worker task. Reading this panel does not start work." } }
                    } else { p { "Workers are not configured on this server." } }
                }
            }
        } else { p {role:"status","{notice}"} }
    }}
}
