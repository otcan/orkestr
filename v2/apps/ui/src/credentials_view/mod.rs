//! Credentials (`#credentials`, ORK-826): the passwords, tokens and API keys
//! the owner's chats and desks may use, as one table. Values are never listed:
//! adding or replacing one sends it once, and showing one is an explicit
//! action the store records (this browser's own key for the built-in vault,
//! the store's own UI under the owner's sign-in for OpenBao).
use dioxus::prelude::*;
use orkestr_v2_contracts::SidebarPage;
use orkestr_v2_ui::credentials::{self, ChatNames, Credential, Page};
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::Value;

mod form;
mod row;

/// Rows rendered at once; "Show more" adds this many.
const PAGE_SIZE: usize = 100;

#[component]
pub fn Credentials(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut page = use_signal(|| None::<Page>);
    let mut names = use_signal(ChatNames::default);
    let mut failure = use_signal(String::new);
    let mut message = use_signal(String::new);
    let mut reload = use_signal(|| 0_u32);
    let mut now = use_signal(|| 0_i64);
    let mut query = use_signal(String::new);
    let mut kind = use_signal(String::new);
    let mut adding = use_signal(|| false);
    let mut editing = use_signal(|| None::<String>);
    let mut deleting = use_signal(|| None::<String>);
    let mut revealed = use_signal(|| None::<(String, Value)>);
    let mut shown = use_signal(|| PAGE_SIZE);
    let mut busy = use_signal(|| false);
    use_resource(move || async move {
        let _ = reload();
        let generation = session_scope.read().generation();
        let listed =
            crate::transport::request::<Page>("GET", "/api/v2/credentials", Value::Null, "", "")
                .await;
        let sidebar = crate::transport::request::<SidebarPage>(
            "GET",
            "/api/v2/sidebar?include_hidden=true",
            Value::Null,
            "",
            "",
        )
        .await;
        let clock = crate::timer_bridge::now_ms().await;
        if !session_scope.read().is_current(generation) {
            return;
        }
        now.set(clock);
        if let Ok(sidebar) = sidebar {
            names.set(ChatNames::from_sidebar(&sidebar.entries));
        }
        match listed {
            Ok(listed) => {
                failure.set(String::new());
                page.set(Some(listed));
            }
            Err(error) if error.status == 401 => failure.set(
                "Credentials need a session signed in with your password. Sign in again.".into(),
            ),
            Err(error) if error.status == 404 => {
                failure.set("This server has no credentials page yet.".into())
            }
            Err(error) => failure.set(error.message),
        }
    });
    let delete = {
        let csrf = csrf.clone();
        move |credential: Credential| {
            let csrf = csrf.clone();
            let generation = session_scope.read().generation();
            busy.set(true);
            spawn(async move {
                let path = format!(
                    "/api/v2/credentials/{}?expected_revision={}",
                    credential.id,
                    percent(&credential.revision)
                );
                let result =
                    crate::transport::request::<Value>("DELETE", &path, Value::Null, &csrf, "")
                        .await;
                if !session_scope.read().is_current(generation) {
                    return;
                }
                busy.set(false);
                match result {
                    Ok(_) => {
                        message.set(format!("Deleted “{}”.", credential.label));
                        deleting.set(None);
                        reload += 1;
                    }
                    Err(error) if error.status == 401 => onexpired.call(()),
                    Err(error) => message.set(error.message),
                }
            });
        }
    };
    let reveal = move |id: String| {
        spawn(async move {
            let mut eval = document::eval(&format!(
                "{}\n{}",
                include_str!("../attachments/age.mjs").replace("export ", ""),
                include_str!("../vault_reveal.js")
            ));
            if eval.send(serde_json::json!({ "id": id })).is_err() {
                return;
            }
            if let Ok(value) = eval.recv::<Value>().await {
                if value["ok"] == true {
                    revealed.set(Some((id, value)));
                } else {
                    message.set(
                        value["message"]
                            .as_str()
                            .unwrap_or("The value could not be opened.")
                            .to_owned(),
                    );
                }
            }
        });
    };

    let Some(current) = page() else {
        return rsx! {
            section { class: "credentials-page", "aria-label": "Credentials",
                style { "{include_str!(\"../credentials.css\")}" }
                p { class: "credentials-intro", role: "status",
                    if failure().is_empty() { "Loading credentials…" } else { "{failure}" }
                }
            }
        };
    };
    let caps = current.capabilities.clone();
    let chat_names = names();
    let rows: Vec<Credential> = current
        .credentials
        .iter()
        .filter(|c| credentials::matches(c, &chat_names, &query(), &kind()))
        .cloned()
        .collect();
    let total = current.credentials.len();
    let matching = rows.len();
    let visible: Vec<Credential> = rows.into_iter().take(shown()).collect();
    let store = if current.backend == "openbao" {
        "Stored in OpenBao."
    } else {
        "Stored in this server's vault."
    };
    let usage_note = match (current.usage.stale, current.usage.observed_at_ms) {
        (true, Some(at)) => Some(format!(
            "“Used by” and “Last used” may be behind: the usage summary is from {}.",
            credentials::ago(now(), at)
        )),
        (true, None) => Some("“Used by” and “Last used” are not available yet.".to_owned()),
        _ => None,
    };
    let counted = if matching == total {
        format!("{total} credentials")
    } else {
        format!("{matching} of {total} credentials")
    };
    rsx! {
        section { class: "credentials-page", "aria-label": "Credentials",
            style { "{include_str!(\"../credentials.css\")}" }
            p { class: "credentials-intro",
                "Passwords, tokens and API keys your chats and desks may use. Values are never shown in this list. "
                small { "{store}" }
            }
            div { class: "credentials-toolbar", role: "search",
                input { r#type: "search", class: "credentials-search", "aria-label": "Search credentials",
                    placeholder: "Search by name, site or chat", value: "{query}",
                    oninput: move |e| { query.set(e.value()); shown.set(PAGE_SIZE); } }
                select { class: "credentials-filter", "aria-label": "Type", onchange: move |e| { kind.set(e.value()); shown.set(PAGE_SIZE); },
                    option { value: "", selected: kind().is_empty(), "All types" }
                    for (value, label) in credentials::TYPES {
                        option { value: value, selected: kind() == value, "{label}" }
                    }
                }
                button { r#type: "button", class: "credentials-add", "aria-expanded": "{adding}",
                    onclick: move |_| { adding.set(!adding()); editing.set(None); deleting.set(None); },
                    if adding() { "Close" } else { "Add credential" }
                }
            }
            if let Some(note) = usage_note { p { class: "credentials-notice", "{note}" } }
            if current.truncated { p { class: "credentials-notice", "Only the first credentials are listed: the store's catalog job has not run yet." } }
            if adding() {
                form::CredentialForm { mode: form::Mode::Add, capabilities: caps.clone(), names: chat_names.clone(),
                    csrf: csrf.clone(), session_scope, onexpired,
                    onsaved: move |text: String| { message.set(text); adding.set(false); reload += 1; },
                    oncancel: move |_| adding.set(false) }
            }
            p { class: "credentials-count", "{counted}" }
            if total == 0 {
                p { class: "credentials-empty", "No credentials yet. Add the first one with “Add credential”." }
            } else if matching == 0 {
                p { class: "credentials-empty", "No credential matches this search." }
            } else {
                div { class: "credentials-table-wrap",
                    table { class: "credentials-table",
                        thead { tr {
                            th { scope: "col", "Credential" }
                            th { scope: "col", "Type" }
                            th { scope: "col", "Used by" }
                            th { scope: "col", "Last used" }
                            th { scope: "col", "Status" }
                            th { scope: "col", span { class: "visually-hidden", "Actions" } }
                        } }
                        tbody {
                            for credential in visible {
                                row::CredentialRow { key: "{credential.id}-{credential.revision}", credential: credential.clone(),
                                    names: chat_names.clone(), capabilities: caps.clone(), now: now(), busy: busy(),
                                    editing: editing().as_deref() == Some(credential.id.as_str()),
                                    deleting: deleting().as_deref() == Some(credential.id.as_str()),
                                    revealed: revealed().filter(|(id, _)| *id == credential.id).map(|(_, v)| v),
                                    onedit: move |id: String| { editing.set(if editing().as_deref() == Some(id.as_str()) { None } else { Some(id) }); deleting.set(None); adding.set(false); },
                                    ondelete: move |id: String| { deleting.set(Some(id)); editing.set(None); },
                                    oncanceldelete: move |_| deleting.set(None),
                                    onconfirmdelete: { let delete = delete.clone(); move |c: Credential| { let mut delete = delete.clone(); delete(c) } },
                                    onreveal: move |id: String| reveal(id),
                                    onhide: move |_| revealed.set(None),
                                }
                                if editing().as_deref() == Some(credential.id.as_str()) {
                                    tr { key: "edit-{credential.id}", class: "credentials-detail",
                                        td { colspan: "6",
                                            form::CredentialForm { key: "edit-{credential.id}-{credential.revision}", mode: form::Mode::Edit(Box::new(credential.clone())),
                                                capabilities: caps.clone(), names: chat_names.clone(), csrf: csrf.clone(), session_scope, onexpired,
                                                onsaved: move |text: String| { message.set(text); editing.set(None); revealed.set(None); reload += 1; },
                                                oncancel: move |_| editing.set(None) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if matching > shown() {
                    p { class: "credentials-more",
                        "Showing {shown()} of {matching}. "
                        button { r#type: "button", onclick: move |_| shown += PAGE_SIZE, "Show {PAGE_SIZE} more" }
                    }
                }
            }
            if caps.vault_import {
                VaultImport { csrf: csrf.clone(), session_scope, onexpired, ondone: move |text: String| { message.set(text); reload += 1; } }
            }
            p { class: "credentials-message", role: "status", "{message}" }
        }
    }
}

/// `%`-encodes an opaque revision for a query string.
fn percent(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The built-in vault's own import format (from an earlier Orkestr vault).
#[component]
fn VaultImport(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    ondone: EventHandler<String>,
) -> Element {
    let mut text = use_signal(String::new);
    let mut busy = use_signal(|| false);
    rsx! {
        details { class: "credentials-import",
            summary { "Import from an Orkestr vault file" }
            p { "Paste an Orkestr vault import (format orkestr-vault-import-v1). Importing the same file again changes nothing." }
            textarea { "aria-label": "Vault import", autocomplete: "off", value: "{text}", oninput: move |e| text.set(e.value()) }
            button { r#type: "button", disabled: busy(), onclick: move |_| {
                let parsed = serde_json::from_str::<Value>(&text());
                text.set(String::new());
                let Ok(body) = parsed else {
                    ondone.call("The import is not valid JSON.".into());
                    return;
                };
                let csrf = csrf.clone();
                let generation = session_scope.read().generation();
                busy.set(true);
                spawn(async move {
                    let result = crate::transport::request::<Value>("POST", "/api/v2/vault/import", body, &csrf, "").await;
                    if !session_scope.read().is_current(generation) { return; }
                    busy.set(false);
                    match result {
                        Ok(v) => ondone.call(format!("Import: {} new, {} updated, {} unchanged, {} conflicts, {} deleted here.",
                            v["imported"], v["updated"], v["unchanged"], v["conflicts"], v["deleted_in_v2"])),
                        Err(error) if error.status == 401 => onexpired.call(()),
                        Err(error) => ondone.call(error.message),
                    }
                });
            }, "Import" }
        }
    }
}
