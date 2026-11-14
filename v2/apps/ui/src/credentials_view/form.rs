//! Add or edit one credential. The fields follow the type; allowed chats are
//! picked by name. An edit lists what changes and is saved only after the
//! owner confirms. A value typed here is sent once and cleared right away.
use dioxus::prelude::*;
use orkestr_v2_ui::credentials::{self, Capabilities, ChatNames, Credential};
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::{json, Map, Value};

#[derive(Clone, PartialEq)]
pub(crate) enum Mode {
    Add,
    Edit(Box<Credential>),
}

/// The value fields a type offers: `(field, label, secret)`.
fn value_fields(kind: &str) -> Vec<(&'static str, &'static str, bool)> {
    let (field, label) = credentials::secret_field(kind);
    let mut out = Vec::new();
    if kind == "password" {
        out.push(("username", "Username or email", false));
    }
    out.push((field, label, true));
    if kind == "password" {
        out.push(("url", "Sign-in page (optional, https://)", false));
    }
    out.push(("notes", "Notes (optional)", false));
    out
}

#[component]
pub(crate) fn CredentialForm(
    mode: Mode,
    capabilities: Capabilities,
    names: ChatNames,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onsaved: EventHandler<String>,
    oncancel: EventHandler<()>,
) -> Element {
    let before = match &mode {
        Mode::Edit(credential) => Some(credential.as_ref().clone()),
        Mode::Add => None,
    };
    let editing = before.is_some();
    let initial = before.clone();
    let mut kind = use_signal(|| {
        initial
            .as_ref()
            .map_or_else(|| "password".to_owned(), |c| c.kind.clone())
    });
    let mut label = use_signal(|| {
        initial
            .as_ref()
            .map(|c| c.label.clone())
            .unwrap_or_default()
    });
    let mut site = use_signal(|| initial.as_ref().map(|c| c.site.clone()).unwrap_or_default());
    let mut allowed = use_signal(|| {
        initial
            .as_ref()
            .map(|c| c.allowed.clone())
            .unwrap_or_default()
    });
    let mut owner_desks = use_signal(|| initial.as_ref().is_none_or(|c| c.owner_desks));
    let mut replace = use_signal(|| initial.is_none());
    let mut values = use_signal(Map::<String, Value>::new);
    let mut reveal_typing = use_signal(|| false);
    let mut chat_query = use_signal(String::new);
    let mut confirm = use_signal(|| None::<Vec<String>>);
    let busy = use_signal(|| false);
    let mut error = use_signal(String::new);

    let current_kind = kind();
    let fields = value_fields(&current_kind);
    let desks_toggle = capabilities.owner_desks_editable && current_kind == "password";
    let site_locked = editing && capabilities.site_with_value && !replace();
    let choices = names.choices(&capabilities.grant_ids);
    let picked = allowed();
    let wanted = chat_query().trim().to_lowercase();
    let mut shown_chats: Vec<(String, String, bool)> = choices
        .iter()
        .filter(|(id, name)| {
            wanted.is_empty() || name.to_lowercase().contains(&wanted) || picked.contains(id)
        })
        .map(|(id, name)| (id.clone(), name.clone(), picked.contains(id)))
        .collect();
    // Chats still allowed but no longer listed can be removed too.
    for id in &picked {
        if !choices.iter().any(|(c, _)| c == id) {
            shown_chats.push((id.clone(), names.label(id), true));
        }
    }
    shown_chats.sort_by_key(|(_, _, on)| !on);
    let replace_hint = if capabilities.value_replace == "fields" {
        "Fill in only what changes; empty fields keep their stored value."
    } else {
        "The whole login is replaced: enter every field again."
    };
    let title = match &before {
        Some(c) => format!("Edit “{}”", c.label),
        None => "Add credential".to_owned(),
    };
    let grants_hint = if capabilities.grant_ids == "v1_thread" {
        "Chats that were set up in Orkestr V1 can be chosen here."
    } else {
        "A chosen chat may sign in with it on its desks and use it in commands; the value never appears in the chat."
    };

    let save = move |_: MouseEvent| {
        if busy() {
            return;
        }
        error.set(String::new());
        let kind_now = kind();
        let (main, main_label) = credentials::secret_field(&kind_now);
        let typed: Map<String, Value> = values()
            .into_iter()
            .filter(|(_, v)| v.as_str().is_some_and(|s| !s.is_empty()))
            .collect();
        if label().trim().is_empty() {
            error.set("Give it a name.".into());
            return;
        }
        if kind_now == "password" && site().trim().is_empty() {
            error.set("A password needs the site it signs in to.".into());
            return;
        }
        let needs_main = !editing || capabilities.value_replace == "whole";
        if replace() && needs_main && !typed.contains_key(main) {
            error.set(format!("Enter the {}.", main_label.to_lowercase()));
            return;
        }
        if replace() && typed.is_empty() {
            error.set("Enter the new value, or untick “Replace the stored value”.".into());
            return;
        }
        let Some(before) = before.clone() else {
            // Add: one request.
            let body = json!({"type": kind_now, "label": label().trim(), "site": site().trim(), "allowed": allowed(),
                "owner_desks": desks_toggle && owner_desks(), "value": Value::Object(typed)});
            values.set(Map::new());
            submit(
                csrf.clone(),
                session_scope,
                onexpired,
                onsaved,
                busy,
                error,
                vec![("POST", "/api/v2/credentials".to_owned(), body)],
                format!("Saved “{}”.", label().trim()),
            );
            return;
        };
        let change = credentials::metadata_change(
            &before,
            &label(),
            &site(),
            &allowed(),
            owner_desks(),
            &capabilities,
        );
        if change.is_none() && !replace() {
            error.set("Nothing changed.".into());
            return;
        }
        if confirm().is_none() {
            confirm.set(Some(credentials::change_summary(
                &before,
                change.as_ref(),
                replace(),
                &names,
            )));
            return;
        }
        let mut steps = Vec::new();
        if let Some(change) = change {
            steps.push((
                "PATCH",
                format!("/api/v2/credentials/{}", before.id),
                change,
            ));
        }
        if replace() {
            let mut body =
                json!({"expected_revision": before.revision, "value": Value::Object(typed)});
            if capabilities.site_with_value {
                body["site"] = json!(site().trim());
            }
            steps.push((
                "PUT",
                format!("/api/v2/credentials/{}/value", before.id),
                body,
            ));
        }
        values.set(Map::new());
        confirm.set(None);
        submit(
            csrf.clone(),
            session_scope,
            onexpired,
            onsaved,
            busy,
            error,
            steps,
            format!("Saved changes to “{}”.", label().trim()),
        );
    };

    rsx! {
        form { class: "credential-form", "aria-label": "{title}", autocomplete: "off",
            onsubmit: move |event| { event.prevent_default(); },
            h3 { "{title}" }
            if !editing {
                fieldset { class: "credential-kinds",
                    legend { "Type" }
                    for (value, text) in credentials::TYPES {
                        label { class: "credential-kind",
                            input { r#type: "radio", name: "credential-kind", value: value, checked: current_kind == value,
                                onchange: move |_| { kind.set(value.to_owned()); values.set(Map::new()); } }
                            "{text}"
                        }
                    }
                }
            }
            div { class: "credential-fields",
                label { "Name"
                    input { name: "label", required: true, maxlength: "200", value: "{label}", oninput: move |e| { label.set(e.value()); confirm.set(None); } }
                }
                label {
                    if current_kind == "password" { "Site" } else { "Site (optional)" }
                    input { name: "site", value: "{site}", disabled: site_locked, inputmode: "url", autocapitalize: "none", spellcheck: "false",
                        "aria-describedby": "credential-site-hint", oninput: move |e| { site.set(e.value()); confirm.set(None); } }
                    small { id: "credential-site-hint", "The website's address or domain; only the domain is kept." }
                }
            }
            if editing {
                label { class: "credential-replace",
                    input { r#type: "checkbox", name: "replace", checked: replace(), onchange: move |e| { replace.set(e.checked()); values.set(Map::new()); confirm.set(None); } }
                    "Replace the stored value"
                }
            }
            if replace() {
                div { class: "credential-fields credential-values",
                    if editing { p { class: "credential-hint", "{replace_hint}" } }
                    for (field, text, secret) in fields {
                        if field == "notes" {
                            label { "{text}"
                                textarea { name: "{field}", value: values().get(field).and_then(Value::as_str).unwrap_or_default().to_owned(),
                                    oninput: move |e| { values.write().insert(field.into(), e.value().into()); } }
                            }
                        } else {
                            label { "{text}"
                                input { name: "{field}", r#type: if secret && !reveal_typing() { "password" } else if field == "url" { "url" } else { "text" },
                                    autocomplete: if secret { "new-password" } else { "off" }, autocapitalize: "none", spellcheck: "false",
                                    value: values().get(field).and_then(Value::as_str).unwrap_or_default().to_owned(),
                                    oninput: move |e| { values.write().insert(field.into(), e.value().into()); confirm.set(None); } }
                            }
                        }
                    }
                    label { class: "credential-show-typing",
                        input { r#type: "checkbox", checked: reveal_typing(), onchange: move |e| reveal_typing.set(e.checked()) }
                        "Show what I type"
                    }
                }
            }
            fieldset { class: "credential-chats",
                legend { "Chats that may use it" }
                p { class: "credential-hint", "{grants_hint}" }
                if choices.len() > 6 {
                    input { r#type: "search", class: "credential-chat-search", "aria-label": "Find a chat", placeholder: "Find a chat",
                        value: "{chat_query}", oninput: move |e| chat_query.set(e.value()) }
                }
                if shown_chats.is_empty() {
                    p { class: "credential-hint", "No chats to choose from." }
                }
                div { class: "credential-chat-list",
                    for (id, name, on) in shown_chats {
                        label { key: "{id}", class: "credential-chat",
                            input { r#type: "checkbox", name: "chat", value: "{id}", checked: on, onchange: {
                                let id = id.clone();
                                move |e: FormEvent| {
                                    let mut list = allowed.write();
                                    if e.checked() { if !list.contains(&id) { list.push(id.clone()); } } else { list.retain(|a| *a != id); }
                                    confirm.set(None);
                                }
                            } }
                            "{name}"
                        }
                    }
                }
                if desks_toggle {
                    label { class: "credential-desks-toggle",
                        input { r#type: "checkbox", name: "owner_desks", checked: owner_desks(), onchange: move |e| { owner_desks.set(e.checked()); confirm.set(None); } }
                        "Your desks may sign in with it automatically"
                    }
                } else if current_kind == "password" {
                    p { class: "credential-hint", "Your desks sign in with stored logins automatically." }
                }
            }
            if let Some(summary) = confirm() {
                div { class: "credential-confirm", role: "alertdialog", "aria-label": "Confirm changes",
                    p { strong { "Save these changes?" } }
                    ul { for line in summary { li { "{line}" } } }
                }
            }
            if !error().is_empty() { p { class: "credential-error", role: "alert", "{error}" } }
            div { class: "credential-buttons",
                button { r#type: "button", class: "credential-save", disabled: busy(), onclick: save,
                    if confirm().is_some() { "Confirm and save" } else if editing { "Save changes" } else { "Save credential" }
                }
                button { r#type: "button", onclick: move |_| { values.set(Map::new()); oncancel.call(()); },
                    if confirm().is_some() { "Back" } else { "Cancel" }
                }
            }
        }
    }
}

/// Runs the requests in order; each answer's revision feeds the next step.
#[allow(clippy::too_many_arguments)]
fn submit(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onsaved: EventHandler<String>,
    mut busy: Signal<bool>,
    mut error: Signal<String>,
    steps: Vec<(&'static str, String, Value)>,
    done: String,
) {
    let generation = session_scope.read().generation();
    busy.set(true);
    spawn(async move {
        let mut revision: Option<Value> = None;
        for (method, path, mut body) in steps {
            if let Some(revision) = revision.take() {
                body["expected_revision"] = revision;
            }
            let result = crate::transport::request::<Value>(method, &path, body, &csrf, "").await;
            if !session_scope.read().is_current(generation) {
                return;
            }
            match result {
                Ok(answer) => revision = Some(answer["revision"].clone()),
                Err(failure) => {
                    busy.set(false);
                    if failure.status == 401 {
                        onexpired.call(());
                    } else {
                        error.set(failure.message);
                    }
                    return;
                }
            }
        }
        busy.set(false);
        onsaved.call(done);
    });
}
