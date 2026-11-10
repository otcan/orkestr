use crate::transport::Failure;
use dioxus::prelude::*;
use orkestr_v2_contracts::{stop_needs_confirmation, DesktopResource, DesktopRuntime};
use orkestr_v2_ui::{
    desk_presentation::{link_grant, stop_outcome, stop_warning},
    session_scope::SessionScope,
};
use serde_json::{json, Value};

#[derive(Clone, PartialEq)]
struct DeskLink {
    url: String,
    expires_at: Option<String>,
}

fn report(
    error: Failure,
    mut status: Signal<String>,
    mut uncertain: Signal<bool>,
    onexpired: EventHandler<()>,
    onchanged: EventHandler<()>,
) {
    match error.status {
        401 => onexpired.call(()),
        // The action may or may not have happened: no retry until a refresh.
        0 | 408 | 500.. => {
            uncertain.set(true);
            status.set(error.message);
        }
        // The server saw newer state; show it instead of the stale row.
        409 => {
            status.set(error.message);
            onchanged.call(());
        }
        _ => status.set(error.message),
    }
}

/// Owner Start, Stop and Link for one desk, usable without a connected chat.
/// Actions appear only when the desk's state allows them, and the server
/// re-checks that state: this view never decides on its own that Stop is safe.
#[component]
pub fn DeskOwnerActions(
    desk: DesktopResource,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onchanged: EventHandler<()>,
    observed_at_ms: i64,
) -> Element {
    let owner = session_scope.read().generation();
    let runtime = DesktopRuntime::from_state(&desk.state);
    let needs_confirmation = stop_needs_confirmation(&desk.lease_state, runtime);
    let busy = use_signal(|| None::<&'static str>);
    let mut confirming = use_signal(|| false);
    let status = use_signal(String::new);
    let uncertain = use_signal(|| false);
    let link = use_signal(|| None::<DeskLink>);
    // A refreshed inventory is the re-check the outcome notice asks for.
    use_effect(use_reactive((&observed_at_ms,), move |(_,)| {
        let mut uncertain = uncertain;
        uncertain.set(false);
    }));
    let send = move |action: &'static str, slug: String, csrf: String, body: Value| {
        if busy.peek().is_some() || *uncertain.peek() {
            return;
        }
        let (mut busy, mut status, mut link, mut confirming) = (busy, status, link, confirming);
        busy.set(Some(action));
        status.set(String::new());
        confirming.set(false);
        spawn(async move {
            let path = format!("/api/v2/desktops/{slug}/{action}");
            let result = crate::transport::request::<Value>("POST", &path, body, &csrf, "").await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            busy.set(None);
            let value = match result {
                Ok(value) => value,
                Err(error) => {
                    report(error, status, uncertain, onexpired, onchanged);
                    return;
                }
            };
            let runtime = value["state"].as_str().unwrap_or("unknown").to_owned();
            match action {
                "start" => {
                    status.set(format!("Desk started. Runtime: {runtime}."));
                    onchanged.call(());
                }
                "stop" => {
                    link.set(None);
                    status.set(stop_outcome(
                        &runtime,
                        value["reservation_after_verified"] != false,
                        value["interrupted_holder"].as_str(),
                    ));
                    onchanged.call(());
                }
                _ => match value["url"].as_str() {
                    Some(url) => link.set(Some(DeskLink {
                        url: url.to_owned(),
                        expires_at: value["expires_at"].as_str().map(str::to_owned),
                    })),
                    None => status.set("No link was returned; refresh and try again.".into()),
                },
            }
        });
    };
    let stop_body = move |desk: &DesktopResource, confirm: bool| {
        json!({
            "expected_lease_state": desk.lease_state,
            "expected_holder": desk.holder,
            "confirm_interruption": confirm,
        })
    };
    let blocked = busy().is_some() || uncertain();
    let show_result = confirming() || link().is_some() || !status().is_empty() || uncertain();
    rsx! {
        div { class: "desk-owner-buttons", role: "group", "aria-label": "Actions for {desk.label}",
            if runtime.can_start() {
                button { r#type: "button", disabled: blocked, onclick: {
                    let (slug, csrf) = (desk.slug.clone(), csrf.clone());
                    move |_| send("start", slug.clone(), csrf.clone(), json!({}))
                }, if busy() == Some("start") { "Starting…" } else { "Start" } }
            }
            if runtime.can_stop() {
                button { r#type: "button", disabled: blocked, onclick: {
                    let (desk, csrf) = (desk.clone(), csrf.clone());
                    move |_| {
                        if needs_confirmation {
                            confirming.set(true);
                        } else {
                            send("stop", desk.slug.clone(), csrf.clone(), stop_body(&desk, false));
                        }
                    }
                }, if busy() == Some("stop") { "Stopping…" } else { "Stop" } }
            }
            if runtime.can_link() && link().is_none() {
                button { r#type: "button", disabled: blocked, onclick: {
                    let (slug, csrf) = (desk.slug.clone(), csrf.clone());
                    move |_| send("link", slug.clone(), csrf.clone(), json!({}))
                }, if busy() == Some("link") { "Creating link…" } else { "Link" } }
            }
        }
        if show_result {
            div { class: "desk-owner-result",
                if confirming() {
                    div { class: "desk-confirm", role: "alert",
                        p { {stop_warning(&desk.label, &desk.lease_state, desk.holder.as_deref(), desk.expires_at.as_deref(), runtime)} }
                        div { class: "desk-confirm-actions",
                            button { r#type: "button", class: "danger", disabled: blocked, onclick: {
                                let (desk, csrf) = (desk.clone(), csrf.clone());
                                move |_| send("stop", desk.slug.clone(), csrf.clone(), stop_body(&desk, true))
                            }, "Stop and interrupt" }
                            button { r#type: "button", onclick: move |_| confirming.set(false), "Keep it running" }
                        }
                    }
                }
                if let Some(link) = link() {
                    div { class: "desk-link",
                        a { href: "{link.url}", target: "_blank", rel: "noopener noreferrer", "Open desk link" }
                        p { class: "field-help", {link_grant(link.expires_at.as_deref(), &desk.lease_state)} }
                    }
                }
                if !status().is_empty() { p { role: "status", "{status}" } }
                if uncertain() { p { class: "field-help", "This action’s outcome needs checking. Refresh the list before trying again." } }
            }
        }
    }
}
