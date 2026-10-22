use dioxus::prelude::*;
use orkestr_v2_contracts::{
    RestrictedApprovalList, RestrictedAuditPage, RestrictedMessagePage, RestrictedPolicy,
    RestrictedThread,
};
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::{json, Value};

async fn pause() {
    let _ = document::eval("await new Promise(r => setTimeout(r, 3000)); return 1;")
        .join::<Value>()
        .await;
}

/// "Restricted thread": the self-hosted model's policy, its pending requests (one
/// tap to allow once, allow for this session, or deny), the audit and its replies.
#[component]
pub fn RestrictedPanel(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut thread = use_signal(|| None::<RestrictedThread>);
    let mut approvals = use_signal(Vec::new);
    let mut audit = use_signal(Vec::new);
    let mut replies = use_signal(Vec::new);
    let mut status = use_signal(String::new);
    let mut reload = use_signal(|| 0_u32);
    let base = format!("/api/v2/conversations/{conversation}/restricted");
    let poll_base = base.clone();
    use_future(move || {
        let base = poll_base.clone();
        async move {
            loop {
                if !session_scope.read().is_current(owner) {
                    return;
                }
                let _ = reload();
                if let Ok(t) =
                    crate::transport::request::<RestrictedThread>("GET", &base, Value::Null, "", "")
                        .await
                {
                    let enabled = t.enabled;
                    thread.set(Some(t));
                    if enabled {
                        match crate::transport::request::<RestrictedApprovalList>(
                            "GET",
                            &format!("{base}/approvals?pending=true"),
                            Value::Null,
                            "",
                            "",
                        )
                        .await
                        {
                            Ok(list) => approvals.set(list.approvals),
                            Err(e) if e.status == 401 => onexpired.call(()),
                            Err(_) => {}
                        }
                        if let Ok(page) = crate::transport::request::<RestrictedAuditPage>(
                            "GET",
                            &format!("{base}/audit?limit=15"),
                            Value::Null,
                            "",
                            "",
                        )
                        .await
                        {
                            audit.set(page.records);
                        }
                        if let Ok(page) = crate::transport::request::<RestrictedMessagePage>(
                            "GET",
                            &format!("{base}/messages?limit=30"),
                            Value::Null,
                            "",
                            "",
                        )
                        .await
                        {
                            replies.set(page.messages);
                        }
                    }
                }
                pause().await;
            }
        }
    });
    let current = thread();
    let enabled = current.as_ref().is_some_and(|t| t.enabled);
    let revision = current.as_ref().map_or(0, |t| t.revision);
    let policy = current.as_ref().and_then(|t| t.policy.clone());
    let decide_base = base.clone();
    let save_base = base.clone();
    let reset_base = base.clone();
    let decide_csrf = csrf.clone();
    let save_csrf = csrf.clone();
    let reset_csrf = csrf.clone();
    rsx! {
        section { class: "settings-form", "aria-label": "Restricted thread",
            h3 { "Restricted thread (self-hosted model)" }
            p { class: "field-help", "The model has no shell, files, credentials or network. Every action it asks for goes through the broker: reading its own workspace and drafts are allowed, sending, writing elsewhere and the GPU wait for you, credentials, host commands, other threads and deletes are always refused." }
            if enabled {
                p { role: "status", "Enabled. Session {current.as_ref().and_then(|t| t.session_id.clone()).unwrap_or_default()}" }
            } else {
                p { role: "status", "Not enabled for this conversation." }
            }
            if !approvals().is_empty() {
                h4 { "Waiting for you" }
                for a in approvals() {
                    div { class: "restricted-approval", key: "{a.id}", role: "group", "aria-label": "Approval request",
                        p { strong { "{a.action}" } " — {a.summary}" }
                        div { class: "field-row",
                            for (label, approve, scope) in [("Allow once", true, "once"), ("Deny", false, "once")] {
                                button { r#type: "button", onclick: {
                                    let (id, base, csrf) = (a.id.clone(), decide_base.clone(), decide_csrf.clone());
                                    move |_| {
                                        let (id, base, csrf) = (id.clone(), base.clone(), decide_csrf_clone(&csrf));
                                        spawn(async move {
                                            let r = crate::transport::request::<Value>("POST", &format!("{base}/approvals/{id}"), json!({"approve": approve, "scope": scope}), &csrf, "").await;
                                            match r { Ok(_) => status.set(String::new()), Err(e) if e.status == 401 => onexpired.call(()), Err(e) => status.set(e.message) }
                                            reload += 1;
                                        });
                                    }
                                }, "{label}" }
                            }
                            if let Some(label) = a.session_grant_label.clone() {
                                button { r#type: "button", onclick: {
                                    let (id, base, csrf) = (a.id.clone(), decide_base.clone(), decide_csrf.clone());
                                    move |_| {
                                        let (id, base, csrf) = (id.clone(), base.clone(), decide_csrf_clone(&csrf));
                                        spawn(async move {
                                            let r = crate::transport::request::<Value>("POST", &format!("{base}/approvals/{id}"), json!({"approve": true, "scope": "session"}), &csrf, "").await;
                                            match r { Ok(_) => status.set(String::new()), Err(e) if e.status == 401 => onexpired.call(()), Err(e) => status.set(e.message) }
                                            reload += 1;
                                        });
                                    }
                                }, "Allow {label} for this session" }
                            }
                        }
                    }
                }
            }
            if !replies().is_empty() {
                h4 { "Model replies" }
                for m in replies() {
                    p { key: "{m.id}", class: if m.role == "notice" { "field-help" } else { "" }, "{m.content.clone().unwrap_or_default()}" }
                }
            }
            if !audit().is_empty() {
                h4 { "Audit (latest first)" }
                ul { class: "restricted-audit",
                    for r in audit() {
                        li { key: "{r.id}", "{r.action} · {r.decision:?} by {r.decider:?} · {r.outcome.clone().unwrap_or_else(|| \"pending\".into())}" }
                    }
                }
            }
            PolicyForm { policy, revision, base: save_base, csrf: save_csrf, onexpired, status, reload }
            if enabled {
                button { r#type: "button", onclick: move |_| {
                    let (base, csrf) = (reset_base.clone(), reset_csrf.clone());
                    spawn(async move {
                        let r = crate::transport::request::<Value>("POST", &format!("{base}/session/reset"), Value::Null, &csrf, "").await;
                        match r { Ok(_) | Err(_) => reload += 1 }
                    });
                }, "End session (revokes \"for this session\" approvals)" }
            }
            if !status().is_empty() { p { role: "status", class: "settings-status", "{status}" } }
        }
    }
}

fn decide_csrf_clone(csrf: &str) -> String {
    csrf.to_owned()
}

#[component]
fn PolicyForm(
    policy: Option<RestrictedPolicy>,
    revision: i64,
    base: String,
    csrf: String,
    onexpired: EventHandler<()>,
    mut status: Signal<String>,
    mut reload: Signal<u32>,
) -> Element {
    let initial = policy.unwrap_or_else(|| {
        serde_json::from_value(json!({"workspace": "", "endpoint": ""})).unwrap()
    });
    let mut form = use_signal(|| initial.clone());
    let mut enabled = use_signal(|| revision > 0);
    let p = form();
    rsx! {
        form { onsubmit: move |event| {
            event.prevent_default();
            let body = json!({"expected_revision": revision, "enabled": enabled(), "policy": form()});
            let (path, csrf) = (base.clone(), csrf.clone());
            spawn(async move {
                match crate::transport::request::<RestrictedThread>("PUT", &path, body, &csrf, "").await {
                    Ok(t) => status.set(format!("Saved (revision {}).", t.revision)),
                    Err(e) if e.status == 401 => onexpired.call(()),
                    Err(e) => status.set(e.message),
                }
                reload += 1;
            });
        },
            h4 { "Policy" }
            label { class: "checkbox", input { r#type: "checkbox", checked: enabled(), onchange: move |e| enabled.set(e.checked()) } "Enabled" }
            label { r#for: "rt-ws", "Workspace (absolute path)" }
            input { id: "rt-ws", value: "{p.workspace}", oninput: move |e| form.write().workspace = e.value() }
            label { r#for: "rt-ep", "Model endpoint name" }
            input { id: "rt-ep", value: "{p.endpoint}", oninput: move |e| form.write().endpoint = e.value() }
            label { class: "checkbox", input { r#type: "checkbox", checked: p.web_enabled, onchange: move |e| form.write().web_enabled = e.checked() } "Web search and fetch" }
            label { class: "checkbox", input { r#type: "checkbox", checked: p.sandbox_enabled, onchange: move |e| form.write().sandbox_enabled = e.checked() } "Sandbox runs (no network unless you allow it)" }
            label { class: "checkbox", input { r#type: "checkbox", checked: p.sandbox_workspace_writable, onchange: move |e| form.write().sandbox_workspace_writable = e.checked() } "Sandbox may write the workspace" }
            label { class: "checkbox", input { r#type: "checkbox", checked: p.messaging_enabled, onchange: move |e| form.write().messaging_enabled = e.checked() } "May ask to send messages (you approve each)" }
            label { class: "checkbox", input { r#type: "checkbox", checked: p.gpu_enabled, onchange: move |e| form.write().gpu_enabled = e.checked() } "May ask to start the GPU (you approve each)" }
            button { r#type: "submit", "Save policy" }
        }
    }
}
