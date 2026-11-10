use dioxus::prelude::*;
use orkestr_v2_contracts::{DesktopLeaseGranted, DesktopResource, DesktopResourceBinding};
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::{json, Value};

#[component]
pub fn DesktopResourceCard(
    desk: DesktopResource,
    bindings: Vec<DesktopResourceBinding>,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onchanged: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut selected = use_signal(String::new);
    let mut token = use_signal(|| None::<String>);
    let mut busy = use_signal(|| false);
    let mut uncertain = use_signal(|| false);
    let mut confirm = use_signal(|| false);
    let mut link_generation = use_signal(|| 0_u64);
    let mut status = use_signal(String::new);
    rsx! {
        article { class: "settings-form", "aria-label": "Desk {desk.slug}",
            h4 { "{desk.label}" }
            p { "{desk.slug} · Runtime: {desk.state} · Reservation: {desk.lease_state}" }
            if let Some(holder) = &desk.holder { p { "Holder: {holder}" } }
            if let Some(expiry) = &desk.expires_at { p { "Expires: {expiry}" } }
            if bindings.is_empty() {
                p { class: "field-help", "Connect this desk to a chat in that chat’s Settings to reserve or manage it." }
            } else {
                label { "Manage for chat"
                    select { value: "{selected}", disabled: busy() || token().is_some() || uncertain(), onchange: move |e| {selected.set(e.value());confirm.set(false);},
                        option { value: "", "Choose a chat…" }
                        for binding in bindings {
                            option { value: "{binding.conversation_id}", "{binding.name}" }
                        }
                    }
                }
                if !selected().is_empty() {
                    ul { class: "lease-list",
                        crate::desktop_open_view::DesktopOpen {key: "{selected()}:{desk.slug}:{owner}:{link_generation}", conversation:selected(),slug:desk.slug.clone(),csrf:csrf.clone(),session_scope,onexpired}
                    }
                }
                button { r#type:"button",disabled:busy() || uncertain() || selected().is_empty() || token().is_some(),onclick:{
                    let (slug,csrf)=(desk.slug.clone(),csrf.clone());
                    move |_| {
                        if busy() || uncertain() || selected().is_empty() || token().is_some() {return;}
                        busy.set(true);status.set(String::new());
                        let (slug,csrf,conversation)=(slug.clone(),csrf.clone(),selected());
                        spawn(async move {
                            let result=crate::transport::request::<DesktopLeaseGranted>("POST",&format!("/api/v2/conversations/{conversation}/desktops/{slug}/acquire"),json!({"ttl_ms":600000,"purpose":"Owner desk reservation"}),&csrf,"").await;
                            if !session_scope.read().is_current(owner) {return;}
                            busy.set(false);
                            match result {
                                Ok(value) if value.lease.conversation_id.to_string()==conversation && value.lease.desktop_slug==slug => {token.set(Some(value.fencing_token));status.set("Reserved for 10 minutes. Release when finished.".into());onchanged.call(());}
                                Ok(_) => {uncertain.set(true);status.set("Reservation returned an unexpected identity. Refresh to inspect its state.".into());}
                                Err(error) if error.status==401 => onexpired.call(()),
                                Err(error) => {if error.status==0 || error.status>=500 || error.status==408 {uncertain.set(true);}status.set(error.message);}
                            }
                        });
                    }
                }, "Reserve for 10 minutes" }
                if let Some(fence)=token() {
                    button {r#type:"button",disabled:busy() || uncertain(),onclick:{
                        let (slug,csrf,fence)=(desk.slug.clone(),csrf.clone(),fence.clone());
                        move |_| {
                            if busy() || uncertain() {return;}
                            busy.set(true);let (slug,csrf,fence,conversation)=(slug.clone(),csrf.clone(),fence.clone(),selected());
                            spawn(async move {
                                let result=crate::transport::request::<Value>("POST",&format!("/api/v2/conversations/{conversation}/desktops/{slug}/release"),json!({"fencing_token":fence,"reason":"Owner finished"}),&csrf,"").await;
                                if !session_scope.read().is_current(owner) {return;}
                                busy.set(false);
                                match result {Ok(_)=>{token.set(None);confirm.set(false);status.set("Reservation released.".into());onchanged.call(());},Err(e) if e.status==401=>onexpired.call(()),Err(e)=>{uncertain.set(true);status.set(e.message);}}
                            });
                        }
                    }, "Release reservation" }
                    button {r#type:"button",disabled:busy() || uncertain(),onclick:move |_|confirm.set(true),"Reset runtime…"}
                    if confirm() {
                        p { "Restart this reserved desk? This interrupts its browser session; saved profile data is preserved." }
                        button {r#type:"button",disabled:busy() || uncertain(),onclick:{
                            let (slug,csrf,fence)=(desk.slug.clone(),csrf.clone(),fence.clone());
                            move |_| {
                                if busy() || uncertain() {return;}
                                busy.set(true);confirm.set(false);link_generation += 1;
                                let (slug,csrf,fence,conversation)=(slug.clone(),csrf.clone(),fence.clone(),selected());
                                spawn(async move {
                                    let result=crate::transport::request::<Value>("POST",&format!("/api/v2/conversations/{conversation}/desktops/{slug}/reset"),json!({"fencing_token":fence,"confirm":true}),&csrf,"").await;
                                    if !session_scope.read().is_current(owner) {return;}
                                    busy.set(false);
                                    match result {Ok(_)=>{status.set("Desk runtime reset.".into());onchanged.call(());},Err(e) if e.status==401=>onexpired.call(()),Err(e)=>{uncertain.set(true);status.set(e.message);}}
                                });
                            }
                        }, "Confirm reset" }
                        button {r#type:"button",onclick:move |_|confirm.set(false),"Cancel"}
                    }
                }
            }
            if !status().is_empty() {p {role:"status","{status}"}}
            if uncertain() {p {class:"field-help","The action’s outcome needs checking. Automatic retries are disabled; refresh the inventory and inspect the reservation before continuing."}}
        }
    }
}
