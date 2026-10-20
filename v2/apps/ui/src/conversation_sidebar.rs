use dioxus::prelude::*;
use orkestr_v2_ui::{
    conversation_directory::{ConversationPage, ConversationSummary, Creation},
    session_scope::SessionScope,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc};

#[derive(Deserialize)]
struct Reply {
    status: u16,
    text: String,
}
fn start(input: Value) -> document::Eval {
    let source =
        include_str!("conversation_request.mjs").replace("export async function", "async function");
    let script=format!("{source}\nconst input=await dioxus.recv();const c=new AbortController();let done=false;dioxus.recv().then(()=>{{if(!done)c.abort();}});try{{return await conversationRequest({{...input,signal:c.signal}});}}finally{{done=true;c.abort();}}");
    let eval = document::eval(&script);
    let _ = eval.send(input);
    eval
}

#[component]
pub fn ConversationSidebar(
    selected: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onselect: EventHandler<ConversationSummary>,
    onloaded: EventHandler<Vec<ConversationSummary>>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut mounted = use_signal(|| true);
    let mut page = use_signal(|| None::<ConversationPage>);
    let mut after = use_signal(|| 0_i64);
    let mut refresh = use_signal(|| 0_u64);
    let mut reading = use_signal(|| None::<document::Eval>);
    let mut writing = use_signal(|| None::<document::Eval>);
    let mut notice = use_signal(String::new);
    let mut create = use_signal(Creation::default);
    let mut open = use_signal(|| false);
    let mut busy = use_signal(|| false);
    let read_ticket = use_hook(|| Rc::new(Cell::new(0_u64)));
    use_drop(move || {
        mounted.set(false);
        for channel in [reading(), writing()].into_iter().flatten() {
            let _ = channel.send(json!({"stop":true}));
        }
    });
    use_resource(move || {
        let cursor = after();
        let _ = refresh();
        let ticket = read_ticket.get() + 1;
        read_ticket.set(ticket);
        let read_ticket = read_ticket.clone();
        async move {
            if let Some(old) = reading.peek().as_ref() {
                let _ = old.send(json!({"stop":true}));
            }
            let channel = start(json!({"method":"GET","after":cursor.to_string(),"body":null}));
            reading.set(Some(channel));
            let result = channel.join::<Reply>().await;
            if !mounted() || !session_scope.read().is_current(owner) || read_ticket.get() != ticket
            {
                return;
            }
            reading.set(None);
            match result {
                Ok(reply) if reply.status == 200 => {
                    match serde_json::from_str::<ConversationPage>(&reply.text) {
                        Ok(value) if value.valid(cursor) => {
                            onloaded.call(value.conversations.clone());
                            page.set(Some(value));
                            notice.set(String::new());
                        }
                        _ => {
                            page.set(None);
                            notice.set("Conversation list could not be verified.".into());
                        }
                    }
                }
                Ok(reply) if reply.status == 401 => onexpired.call(()),
                _ => notice.set("Conversations unavailable. Refresh to try again.".into()),
            }
        }
    });
    let next = page.read().as_ref().and_then(|p| p.next_cursor);
    rsx! { aside { class:"conversation-sidebar", "aria-label":"Conversations",
        div { class:"sidebar-heading", h2 {"Conversations"} button { onclick:move |_|open.set(!open()), "New conversation" } }
        if open() {
            form { class:"new-conversation", onsubmit:move |event|{
                event.prevent_default();if busy()||!session_scope.read().is_current(owner){return;}
                busy.set(true);let csrf=csrf.clone();
                spawn(async move {
                    let result=async {
                        let key=crate::transport::key().await?;
                        if !mounted()||!session_scope.read().is_current(owner){return Ok(None);}
                        let request=create.write().prepare(key).map_err(|m|crate::transport::Failure::from(m.to_string()))?;
                        let body=serde_json::to_string(&request).map_err(|_|crate::transport::Failure::from("Conversation request unavailable.".to_string()))?;
                        let channel=start(json!({"method":"POST","body":body,"csrf":csrf}));writing.set(Some(channel));
                        let reply=channel.join::<Reply>().await.map_err(|_|crate::transport::Failure::from("Creation not confirmed. Retry keeps the same request.".to_string()))?;
                        if !mounted()||!session_scope.read().is_current(owner){return Ok(None);}
                        if reply.status==401{onexpired.call(());return Ok(None);}
                        if ![200,201].contains(&reply.status){
                            if matches!(reply.status,400|403|404|409|422){create.write().pending=None;}
                            return Err(crate::transport::Failure::from("Conversation not created. Review the name or retry the same request.".to_string()));
                        }
                        let row=serde_json::from_str::<ConversationSummary>(&reply.text).map_err(|_|crate::transport::Failure::from("Creation reply could not be verified.".to_string()))?;
                        if !create.read().confirmed(&row){return Err(crate::transport::Failure::from("Creation reply does not match this conversation.".to_string()));}
                        Ok(Some(row))
                    }.await;
                    if !mounted()||!session_scope.read().is_current(owner){return;}
                    writing.set(None);busy.set(false);
                    match result { Ok(Some(row))=>{create.set(Creation::default());open.set(false);refresh+=1;onselect.call(row);}, Ok(None)=>{}, Err(error)=>notice.set(error.message) }
                });
            },
                label {r#for:"conversation-name","Conversation name"}
                input {id:"conversation-name",value:"{create.read().name}",disabled:busy()||create.read().pending.is_some(),oninput:move|e|create.write().name=e.value(),placeholder:"What are you working on?"}
                button {r#type:"submit",disabled:busy(),if busy(){"Creating…"}else if create.read().pending.is_some(){"Retry creation"}else{"Create conversation"}}
            }
        }
        nav { "aria-label":"Conversation list",
            if let Some(value)=page.read().as_ref(){for row in &value.conversations {
                button {key:"{row.conversation_id}",class:"conversation-choice","aria-current":if row.conversation_id.to_string()==selected{"page"}else{"false"},onclick:{let row=row.clone();move |_|{if session_scope.read().is_current(owner){onselect.call(row.clone());}}},"{row.name}"}
            }}
        }
        p {role:"status","{notice}"}
        div {class:"directory-pagination",
            button {disabled:after()==0,onclick:move |_|after.set(0),"First"}
            button {disabled:next.is_none(),onclick:move |_|{if let Some(next)=next{after.set(next);}},"More"}
            button {onclick:move |_|refresh+=1,"Refresh"}
        }
    }}
}
