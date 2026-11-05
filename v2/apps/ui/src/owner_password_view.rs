use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::{json, Value};

#[component]
pub fn OwnerPassword(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut username = use_signal(String::new);
    let mut current = use_signal(String::new);
    let mut replacement = use_signal(String::new);
    let mut confirmation = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut status = use_signal(String::new);
    let mut ready = use_signal(|| false);
    use_resource(move || async move {
        let generation = session_scope.read().generation();
        let result = crate::transport::request::<Value>(
            "GET",
            "/api/v2/browser/security",
            Value::Null,
            "",
            "",
        )
        .await;
        if !session_scope.read().is_current(generation) {
            return;
        }
        match result {
            Ok(value) => ready.set(value["password_rotation_ready"].as_bool().unwrap_or(false)),
            Err(error) => status.set(error.message),
        }
    });
    rsx! {
        details { class: "owner-password",
            summary { "Change password" }
            form { onsubmit: move |event| {
                event.prevent_default();
                if busy() || !ready() { return; }
                if replacement() != confirmation() {
                    status.set("The new passwords do not match.".into()); return;
                }
                let body = json!({"username":username(), "current_password":current(), "new_password":replacement()});
                current.set(String::new()); replacement.set(String::new()); confirmation.set(String::new());
                busy.set(true);
                let generation = session_scope.read().generation();
                let csrf = csrf.clone();
                spawn(async move {
                    let result = crate::transport::request::<Value>("POST", "/api/v2/browser/password", body, &csrf, "").await;
                    if !session_scope.read().is_current(generation) { return; }
                    busy.set(false);
                    match result {
                        Ok(_) => { status.set("Password changed. Sign in again.".into()); onexpired.call(()); }
                        Err(error) => status.set(error.message),
                    }
                });
            },
                label { r#for: "password-owner", "Username" }
                input { id: "password-owner", autocomplete: "username", required: true, value: "{username}", oninput: move |e| username.set(e.value()) }
                label { r#for: "password-current", "Current password" }
                input { id: "password-current", r#type: "password", autocomplete: "current-password", required: true, value: "{current}", oninput: move |e| current.set(e.value()) }
                label { r#for: "password-new", "New password" }
                input { id: "password-new", r#type: "password", autocomplete: "new-password", required: true, minlength: "12", value: "{replacement}", oninput: move |e| replacement.set(e.value()) }
                label { r#for: "password-confirm", "Confirm new password" }
                input { id: "password-confirm", r#type: "password", autocomplete: "new-password", required: true, value: "{confirmation}", oninput: move |e| confirmation.set(e.value()) }
                if ready() { p { "Changing your password signs out browser sessions. Automation stays connected." } }
                else { p { "Password changes will be available after automation credentials are migrated." } }
                button { r#type: "submit", disabled: busy() || !ready(), if busy() { "Changing…" } else { "Change password" } }
                p { role: "status", "{status}" }
            }
        }
    }
}
