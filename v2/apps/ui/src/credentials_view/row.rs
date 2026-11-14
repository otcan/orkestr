//! One credential in the table, and its delete confirmation and shown value.
//! Each cell names its column (`data-label`), so a phone shows a card.
use dioxus::prelude::*;
use orkestr_v2_ui::credentials::{self, Capabilities, ChatNames, Credential, DESKS};
use serde_json::Value;

#[component]
pub(crate) fn CredentialRow(
    credential: Credential,
    names: ChatNames,
    capabilities: Capabilities,
    now: i64,
    busy: bool,
    editing: bool,
    deleting: bool,
    revealed: Option<Value>,
    onedit: EventHandler<String>,
    ondelete: EventHandler<String>,
    oncanceldelete: EventHandler<()>,
    onconfirmdelete: EventHandler<Credential>,
    onreveal: EventHandler<String>,
    onhide: EventHandler<()>,
) -> Element {
    let id = credential.id.clone();
    let users: Vec<(String, bool)> = credentials::used_by(&credential, &names)
        .into_iter()
        .map(|name| {
            let desks = name == DESKS;
            (name, desks)
        })
        .collect();
    let (status, tone) = credentials::status(&credential);
    let detail = credential
        .usage
        .status_detail
        .as_deref()
        .map(credentials::status_detail);
    let status_title = credential
        .usage
        .status_at_ms
        .map(credentials::absolute_time)
        .unwrap_or_default();
    let last = credentials::last_used(&credential, &names, now);
    let last_title = credential
        .usage
        .last_used_at_ms
        .map(credentials::absolute_time)
        .unwrap_or_default();
    let more_chats = credential.usage.chats.len();
    let kind = credentials::type_label(&credential.kind);
    let reveal_link = credentials::reveal_link(&capabilities, &id);
    let browser_reveal = capabilities.reveal == "browser";
    let secret = credentials::secret_field(&credential.kind);
    let shown = revealed.as_ref().map(|value| {
        let field = |key: &str| value[key].as_str().unwrap_or_default().to_owned();
        (field("username"), field("password"), field("notes"))
    });
    let deleted_note = if capabilities.reveal == "external" {
        "OpenBao keeps its earlier versions, so an administrator can restore it."
    } else {
        "This cannot be undone."
    };
    rsx! {
        tr { class: "credential-row", "data-credential": "{id}",
            td { "data-label": "Credential", class: "credential-name",
                strong { "{credential.label}" }
                if !credential.site.is_empty() { span { class: "credential-site", "{credential.site}" } }
            }
            td { "data-label": "Type", span { class: "credential-type", "data-type": "{credential.kind}", "{kind}" } }
            td { "data-label": "Used by", class: "credential-users",
                if users.is_empty() {
                    span { class: "credential-none", "No chat yet" }
                } else {
                    ul {
                        for (name, desks) in users {
                            li { class: if desks { "credential-user credential-desks" } else { "credential-user" }, "{name}" }
                        }
                    }
                }
            }
            td { "data-label": "Last used", class: "credential-last", title: "{last_title}",
                if let Some((when, by)) = last {
                    span { "{when}" }
                    if let Some(by) = by { span { class: "credential-by", "by {by}" } }
                    if more_chats > 1 { span { class: "credential-by", "{more_chats} chats so far" } }
                } else {
                    span { class: "credential-none", "Not yet" }
                }
            }
            td { "data-label": "Status", title: "{status_title}",
                span { class: "credential-status", "data-tone": "{tone}", "{status}" }
                if let Some(detail) = detail { span { class: "credential-detail", "{detail}" } }
            }
            td { "data-label": "Actions", class: "credential-actions",
                button { r#type: "button", disabled: busy, "aria-expanded": "{editing}",
                    onclick: { let id = id.clone(); move |_| onedit.call(id.clone()) }, "Edit" }
                if let Some(link) = reveal_link {
                    a { class: "credential-reveal", href: "{link}", target: "_blank", rel: "noopener noreferrer",
                        title: "Opens it in OpenBao, which shows the value after you sign in there and records that you looked.",
                        "Show in OpenBao" }
                } else if browser_reveal {
                    if shown.is_some() {
                        button { r#type: "button", onclick: move |_| onhide.call(()), "Hide value" }
                    } else {
                        button { r#type: "button", disabled: busy, title: "Opens the value in this browser with its own key; the vault records it.",
                            onclick: { let id = id.clone(); move |_| onreveal.call(id.clone()) }, "Show value" }
                    }
                }
                button { r#type: "button", class: "credential-delete", disabled: busy,
                    onclick: { let id = id.clone(); move |_| ondelete.call(id.clone()) }, "Delete" }
            }
        }
        if deleting {
            tr { class: "credentials-detail credentials-confirm",
                td { colspan: "6", role: "alertdialog", "aria-label": "Delete {credential.label}",
                    p { strong { "Delete “{credential.label}”?" } " Chats and desks lose access to it at once. {deleted_note}" }
                    button { r#type: "button", class: "credential-delete", disabled: busy,
                        onclick: { let credential = credential.clone(); move |_| onconfirmdelete.call(credential.clone()) }, "Delete" }
                    button { r#type: "button", onclick: move |_| oncanceldelete.call(()), "Cancel" }
                }
            }
        }
        if let Some((username, value, notes)) = shown.clone() {
            tr { class: "credentials-detail credentials-revealed",
                td { colspan: "6",
                    dl {
                        if !username.is_empty() {
                            dt { "Username" } dd { "{username}" }
                        }
                        dt { "{secret.1}" } dd { class: "credential-secret", "{value}" }
                        if !notes.is_empty() {
                            dt { "Notes" } dd { "{notes}" }
                        }
                    }
                    button { r#type: "button", onclick: move |_| onhide.call(()), "Hide value" }
                }
            }
        }
    }
}
