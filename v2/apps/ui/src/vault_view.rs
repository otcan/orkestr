//! Settings > Vault (ORK-784): the owner's stored logins.
//!
//! A login is typed here and sent once; the server stores only ciphertext.
//! "Show" fetches that ciphertext and opens it in this browser with its own
//! key (`vault_reveal.js`); "Hide" drops the values again. Name and tags are
//! plain metadata; URL, username, password and notes are replaced together.
use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::{json, Value};

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}
fn tag_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}
fn stored_login_label(status: &Value) -> &'static str {
    match status["stored_login"].as_str() {
        Some("ready") => "Stored login can use these logins.",
        Some("config_rejected") => "Stored login is configured but its file was refused.",
        _ => "Stored login is not configured on this server.",
    }
}

#[component]
pub fn Vault(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut status = use_signal(|| Value::Null);
    let mut items = use_signal(Vec::<Value>::new);
    let mut message = use_signal(String::new);
    let mut reload = use_signal(|| 0_u32);
    let mut busy = use_signal(|| false);
    let mut revealed = use_signal(|| None::<(String, Value)>);
    let mut editing = use_signal(|| None::<String>);
    let mut audit = use_signal(Vec::<Value>::new);
    let mut name = use_signal(String::new);
    let mut url = use_signal(String::new);
    let mut username = use_signal(String::new);
    let mut password = use_signal(String::new);
    let mut notes = use_signal(String::new);
    let mut tags = use_signal(String::new);
    let mut import_text = use_signal(String::new);
    use_resource(move || async move {
        let _ = reload();
        let generation = session_scope.read().generation();
        let read = crate::transport::request::<Value>("GET", "/api/v2/vault", Value::Null, "", "");
        let listed =
            crate::transport::request::<Value>("GET", "/api/v2/vault/items", Value::Null, "", "");
        let (read, listed) = (read.await, listed.await);
        if !session_scope.read().is_current(generation) {
            return;
        }
        match (read, listed) {
            (Ok(read), Ok(listed)) => {
                status.set(read);
                items.set(listed["items"].as_array().cloned().unwrap_or_default());
            }
            (Err(error), _) | (_, Err(error)) if error.status == 401 => message.set(
                "The vault needs a session signed in with your password. Sign in again.".into(),
            ),
            (Err(error), _) | (_, Err(error)) if error.status == 404 => {
                message.set("This server has no vault yet.".into())
            }
            (Err(error), _) | (_, Err(error)) => message.set(error.message),
        }
    });
    // One owner request; on success reloads the list and shows `done`.
    let send = move |method: &'static str, path: String, body: Value, done: String| {
        let csrf = csrf.clone();
        let generation = session_scope.read().generation();
        busy.set(true);
        spawn(async move {
            let result = crate::transport::request::<Value>(method, &path, body, &csrf, "").await;
            if !session_scope.read().is_current(generation) {
                return;
            }
            busy.set(false);
            match result {
                Ok(value) => {
                    let summary = if value["format"] == "orkestr-vault-import-report-v1" {
                        format!(
                            "Import: {} new, {} updated, {} unchanged, {} conflicts, {} deleted here.",
                            value["imported"], value["updated"], value["unchanged"], value["conflicts"], value["deleted_in_v2"]
                        )
                    } else {
                        done
                    };
                    message.set(summary);
                    editing.set(None);
                    reload += 1;
                }
                Err(error) if error.status == 401 => {
                    message.set("Sign in again with your password.".into());
                    onexpired.call(());
                }
                Err(error) => message.set(error.message),
            }
        });
    };
    let reveal = move |id: String| {
        spawn(async move {
            let mut eval = document::eval(&format!(
                "{}\n{}",
                include_str!("attachments/age.mjs").replace("export ", ""),
                include_str!("vault_reveal.js")
            ));
            if eval.send(json!({ "id": id })).is_err() {
                return;
            }
            if let Ok(value) = eval.recv::<Value>().await {
                if value["ok"] == true {
                    revealed.set(Some((id, value)));
                } else {
                    message.set(text(&value, "message"));
                }
            }
        });
    };
    let mut add = send.clone();
    let mut import = send.clone();
    let count = items.read().len();
    let label = stored_login_label(&status.read());
    let rows: Vec<(String, Value, Option<Value>, bool)> = items
        .read()
        .iter()
        .map(|item| {
            let id = text(item, "id");
            let shown = revealed
                .read()
                .as_ref()
                .filter(|(shown, _)| *shown == id)
                .map(|(_, v)| v.clone());
            let open = editing.read().as_deref() == Some(id.as_str());
            (
                format!("{id}-{}", item["revision"]),
                item.clone(),
                shown,
                open,
            )
        })
        .collect();
    let events: Vec<(String, String)> = audit
        .read()
        .iter()
        .map(|e| {
            let line = ["event", "item_id", "site", "desk", "detail"]
                .iter()
                .map(|k| text(e, k))
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            (e["sequence"].to_string(), line)
        })
        .collect();
    rsx! {
        details { class: "vault",
            summary { "Vault (stored logins)" }
            p { "{count} logins. {label} Logins are encrypted; this browser can show those saved after it was enrolled." }
            form { "aria-label": "Add a login", autocomplete: "off", onsubmit: move |event| {
                event.prevent_default();
                if busy() { return; }
                let body = json!({"name": name(), "url": url(), "username": username(), "password": password(), "notes": notes(), "tags": tag_list(&tags())});
                password.set(String::new()); username.set(String::new()); notes.set(String::new());
                name.set(String::new()); url.set(String::new()); tags.set(String::new());
                add("POST", "/api/v2/vault/items".into(), body, "Login saved.".into());
            },
                label { r#for: "vault-name", "Name" }
                input { id: "vault-name", required: true, maxlength: "200", value: "{name}", oninput: move |e| name.set(e.value()) }
                label { r#for: "vault-url", "Address" }
                input { id: "vault-url", r#type: "url", placeholder: "https://example.com/login", value: "{url}", oninput: move |e| url.set(e.value()) }
                label { r#for: "vault-username", "Username" }
                input { id: "vault-username", autocomplete: "off", value: "{username}", oninput: move |e| username.set(e.value()) }
                label { r#for: "vault-password", "Password" }
                input { id: "vault-password", r#type: "password", autocomplete: "new-password", value: "{password}", oninput: move |e| password.set(e.value()) }
                label { r#for: "vault-notes", "Notes" }
                textarea { id: "vault-notes", value: "{notes}", oninput: move |e| notes.set(e.value()) }
                label { r#for: "vault-tags", "Tags (comma separated)" }
                input { id: "vault-tags", value: "{tags}", oninput: move |e| tags.set(e.value()) }
                button { r#type: "submit", disabled: busy(), "Save login" }
            }
            ul { class: "vault-items",
                for (row_key, item, shown, open) in rows {
                    VaultRow {
                        key: "{row_key}",
                        item,
                        busy: busy(),
                        shown,
                        editing: open,
                        onreveal: move |id: String| reveal(id),
                        onhide: move |_| revealed.set(None),
                        onedit: move |id: String| editing.set(Some(id)),
                        oncancel: move |_| editing.set(None),
                        onsend: {
                            let send = send.clone();
                            move |(method, path, body, done): (&'static str, String, Value, String)| {
                                let mut send = send.clone();
                                revealed.set(None);
                                send(method, path, body, done)
                            }
                        },
                    }
                }
            }
            details { class: "vault-import",
                summary { "Import" }
                p { "Paste an Orkestr vault import (format orkestr-vault-import-v1). Importing the same file again changes nothing." }
                textarea { "aria-label": "Vault import", autocomplete: "off", value: "{import_text}", oninput: move |e| import_text.set(e.value()) }
                button { disabled: busy(), onclick: move |_| {
                    let parsed = serde_json::from_str::<Value>(&import_text());
                    import_text.set(String::new());
                    match parsed {
                        Ok(body) => import("POST", "/api/v2/vault/import".into(), body, String::new()),
                        Err(_) => message.set("The import is not valid JSON.".into()),
                    }
                }, "Import" }
            }
            details { class: "vault-audit",
                summary { "Recent vault activity" }
                button { onclick: move |_| {
                    spawn(async move {
                        if let Ok(value) = crate::transport::request::<Value>("GET", "/api/v2/vault/audit", Value::Null, "", "").await {
                            audit.set(value["events"].as_array().cloned().unwrap_or_default());
                        }
                    });
                }, "Load" }
                ul {
                    for (sequence, line) in events {
                        li { key: "{sequence}", "{line}" }
                    }
                }
            }
            p { role: "status", "{message}" }
        }
    }
}

#[component]
fn VaultRow(
    item: Value,
    busy: bool,
    shown: Option<Value>,
    editing: bool,
    onreveal: EventHandler<String>,
    onhide: EventHandler<()>,
    onedit: EventHandler<String>,
    oncancel: EventHandler<()>,
    onsend: EventHandler<(&'static str, String, Value, String)>,
) -> Element {
    let id = text(&item, "id");
    let revision = item["revision"].as_i64().unwrap_or(0);
    let tags_text = item["tags"]
        .as_array()
        .map(|t| {
            t.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let grants_text = item["thread_grants"]
        .as_array()
        .map(|t| {
            t.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let mut name = use_signal(|| text(&item, "name"));
    let mut tags = use_signal(|| tags_text.clone());
    let mut grants = use_signal(|| grants_text.clone());
    let mut url = use_signal(|| text(&item, "url"));
    let mut username = use_signal(String::new);
    let mut password = use_signal(String::new);
    let mut notes = use_signal(String::new);
    let ready = item["stored_login_ready"] == true;
    let item_name = text(&item, "name");
    let domain = text(&item, "domain");
    let (shown_user, shown_password, shown_notes) = shown
        .as_ref()
        .map(|v| (text(v, "username"), text(v, "password"), text(v, "notes")))
        .unwrap_or_default();
    let is_shown = shown.is_some();
    let path = format!("/api/v2/vault/items/{id}");
    rsx! {
        li { "data-vault-item": "{id}",
            strong { "{item_name}" }
            " "
            span { "{domain}" }
            small {
                if ready { " Stored login ready." } else { " Not available to stored login." }
                if !grants_text.is_empty() { " Threads: {grants_text}." }
                if !tags_text.is_empty() { " Tags: {tags_text}." }
            }
            if is_shown {
                dl {
                    dt { "Username" } dd { "{shown_user}" }
                    dt { "Password" } dd { "{shown_password}" }
                    dt { "Notes" } dd { "{shown_notes}" }
                }
                button { onclick: move |_| onhide.call(()), "Hide" }
            } else {
                button { disabled: busy, onclick: { let id = id.clone(); move |_| onreveal.call(id.clone()) }, "Show" }
            }
            button { disabled: busy, onclick: { let id = id.clone(); move |_| onedit.call(id.clone()) }, "Edit" }
            button { disabled: busy, onclick: {
                let path = path.clone();
                move |_| onsend.call(("DELETE", path.clone(), Value::Null, "Login deleted.".into()))
            }, "Delete" }
            if editing {
                form { "aria-label": "Edit login", autocomplete: "off", onsubmit: {
                    let path = path.clone();
                    move |event: FormEvent| {
                        event.prevent_default();
                        onsend.call(("PATCH", path.clone(), json!({"expected_revision": revision, "name": name(), "tags": tag_list(&tags())}), "Login renamed.".into()));
                    }
                },
                    label { "Name" input { value: "{name}", oninput: move |e| name.set(e.value()) } }
                    label { "Tags" input { value: "{tags}", oninput: move |e| tags.set(e.value()) } }
                    button { r#type: "submit", disabled: busy, "Save name and tags" }
                }
                form { "aria-label": "Replace login", autocomplete: "off", onsubmit: {
                    let path = path.clone();
                    move |event: FormEvent| {
                        event.prevent_default();
                        let body = json!({"expected_revision": revision, "url": url(), "username": username(), "password": password(), "notes": notes()});
                        password.set(String::new()); username.set(String::new()); notes.set(String::new());
                        onsend.call(("PUT", format!("{}/login", path), body, "Login replaced.".into()));
                    }
                },
                    p { "Replacing a login sets address, username, password and notes together." }
                    label { "Address" input { r#type: "url", value: "{url}", oninput: move |e| url.set(e.value()) } }
                    label { "Username" input { autocomplete: "off", value: "{username}", oninput: move |e| username.set(e.value()) } }
                    label { "Password" input { r#type: "password", autocomplete: "new-password", value: "{password}", oninput: move |e| password.set(e.value()) } }
                    label { "Notes" textarea { value: "{notes}", oninput: move |e| notes.set(e.value()) } }
                    button { r#type: "submit", disabled: busy, "Replace login" }
                }
                form { "aria-label": "Thread grants", onsubmit: {
                    let path = path.clone();
                    move |event: FormEvent| {
                        event.prevent_default();
                        onsend.call(("PUT", format!("{}/grants", path), json!({"expected_revision": revision, "v1_thread_ids": tag_list(&grants())}), "Grants saved.".into()));
                    }
                },
                    label { "Threads that may use this login (V1 thread ids, comma separated)" input { value: "{grants}", oninput: move |e| grants.set(e.value()) } }
                    button { r#type: "submit", disabled: busy, "Save grants" }
                }
                button { onclick: move |_| oncancel.call(()), "Close" }
            }
        }
    }
}
