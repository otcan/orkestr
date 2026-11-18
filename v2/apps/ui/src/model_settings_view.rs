use crate::transport::request;
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    ConversationProvider, ConversationSettings, FastRoleSettings, CODEX_EFFORTS,
};
use orkestr_v2_ui::{
    model_settings::{
        heading_label, heading_title, observed_model, FastForm, RoleModel, FAST_SUGGESTIONS,
    },
    session_scope::SessionScope,
};
use serde_json::{json, Value};

/// The model the latest Deep run reported, read once (no polling; the UI
/// never reads a second execution role). A chat without a run, or a read the
/// server refuses, has no evidence.
async fn last_model(path: String) -> Option<String> {
    request::<Value>("GET", &path, Value::Null, "", "")
        .await
        .ok()
        .and_then(|status| observed_model(&status))
}

#[derive(Clone, PartialEq)]
struct Models {
    deep: ConversationSettings,
    /// `None` when the server has no Fast settings for this chat.
    fast: Option<FastRoleSettings>,
    last_deep: Option<String>,
}

/// The chat heading's model line: Deep and Fast at a glance; it opens chat
/// settings. Read once per mount; a failed read shows nothing.
#[component]
pub fn HeadingModels(
    conversation: String,
    session_scope: Signal<SessionScope>,
    onopen: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut label = use_signal(|| None::<(String, String)>);
    use_resource(move || {
        let base = format!("/api/v2/conversations/{conversation}");
        async move {
            let Ok(deep) = request::<ConversationSettings>(
                "GET",
                &format!("{base}/settings"),
                Value::Null,
                "",
                "",
            )
            .await
            else {
                return;
            };
            let fast = request::<FastRoleSettings>(
                "GET",
                &format!("{base}/fast/settings"),
                Value::Null,
                "",
                "",
            )
            .await
            .ok();
            // An unset Deep model is the installation's choice: name the one
            // the latest reply actually used.
            let last = match deep.model {
                Some(_) => None,
                None => last_model(format!("{base}/execution")).await,
            };
            if !session_scope.read().is_current(owner) {
                return;
            }
            let deep_role = RoleModel::deep(&deep, last);
            let fast_role = (fast.is_some() || deep.provider == ConversationProvider::Claude)
                .then(|| RoleModel::fast(&deep, fast.as_ref(), None));
            label.set(Some((
                heading_label(&deep_role, fast_role.as_ref()),
                heading_title(&deep_role, fast_role.as_ref()),
            )));
        }
    });
    let Some((text, title)) = label() else {
        return rsx! {};
    };
    rsx! {
        button { class: "heading-models", r#type: "button", title: "{title}",
            onclick: move |_| onopen.call(()),
            "{text}"
        }
    }
}

/// Chat settings: provider, model and effort of Deep and Fast, the model the
/// last Deep reply used, and the Fast model change (Deep is changed in the
/// thread settings below). `refresh` is bumped when those are saved.
#[component]
pub fn ModelSummary(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    refresh: Signal<u32>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut models = use_signal(|| None::<Models>);
    let mut form = use_signal(|| None::<FastForm>);
    let mut status = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut reload = use_signal(|| 0_u32);
    let base = format!("/api/v2/conversations/{conversation}");
    let read_base = base.clone();
    use_resource(move || {
        let _ = (reload(), refresh());
        let base = read_base.clone();
        async move {
            let deep = request::<ConversationSettings>(
                "GET",
                &format!("{base}/settings"),
                Value::Null,
                "",
                "",
            )
            .await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            let deep = match deep {
                Ok(value) => value,
                Err(error) if error.status == 401 => {
                    onexpired.call(());
                    return;
                }
                Err(error) => {
                    status.set(format!("Models unavailable: {}", error.message));
                    return;
                }
            };
            let fast = request::<FastRoleSettings>(
                "GET",
                &format!("{base}/fast/settings"),
                Value::Null,
                "",
                "",
            )
            .await;
            if fast.as_ref().is_err_and(|error| error.status == 401) {
                onexpired.call(());
                return;
            }
            let fast = fast.ok();
            let last_deep = last_model(format!("{base}/execution")).await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            form.set(fast.as_ref().map(FastForm::from_settings));
            models.set(Some(Models {
                deep,
                fast,
                last_deep,
            }));
        }
    });
    let Some(current) = models() else {
        return rsx! { p { class: "settings-loading", if status().is_empty() { "Loading models…" } else { "{status}" } } };
    };
    let deep = RoleModel::deep(&current.deep, current.last_deep.clone());
    let fast = RoleModel::fast(&current.deep, current.fast.as_ref(), None);
    let codex = current.deep.provider == ConversationProvider::Codex;
    let notes: Vec<String> = [deep.drift(), fast.drift()].into_iter().flatten().collect();
    let put_path = format!("{base}/fast/settings");
    rsx! {
        section { class: "settings-form model-summary", "aria-label": "Models",
            h3 { "Models" }
            p { class: "field-help", "Deep writes the full replies and does the work; Fast sends the quick first answer. A change applies from that role's next turn." }
            for entry in [deep, fast] {
                div { key: "{entry.role}", class: "model-role", role: "group", "aria-label": "{entry.role} model",
                    h4 { "{entry.role}" }
                    dl { class: "model-facts",
                        div { dt { "Provider" } dd { "{entry.provider.as_str()}" } }
                        div { dt { "Model" } dd { "{entry.model_text()}" } }
                        div { dt { "Effort" } dd { "{entry.effort_text()}" } }
                        if entry.role == "Deep" { div { dt { "Last reply" } dd { "{entry.last_text()}" } } }
                    }
                }
            }
            for note in notes {
                p { key: "{note}", class: "field-help model-drift", "{note}" }
            }
            button { r#type: "button", class: "model-change-deep",
                onclick: move |_| { let _ = document::eval("document.getElementById('settings-model')?.focus();return null;"); },
                "Change Deep model"
            }
            if !codex {
                p { class: "field-help", "Claude Fast always answers with sonnet at low effort." }
            } else if let Some(fast_form) = form() {
                form { class: "fast-model-form", "aria-label": "Change the Fast model", onsubmit: move |event| {
                    event.prevent_default();
                    if busy() { return; }
                    let Some(update) = form.read().as_ref().map(FastForm::update) else { return };
                    let update = match update { Ok(update) => update, Err(message) => { status.set(message.into()); return; } };
                    busy.set(true);
                    let (path, csrf) = (put_path.clone(), csrf.clone());
                    spawn(async move {
                        let result = request::<FastRoleSettings>("PUT", &path, json!(update), &csrf, "").await;
                        if !session_scope.read().is_current(owner) { return; }
                        busy.set(false);
                        match result {
                            Ok(value) => { status.set(format!("Fast model saved (revision {}). Applies from the next Fast reply.", value.revision)); reload += 1; }
                            Err(error) if error.status == 401 => onexpired.call(()),
                            Err(error) if error.status == 409 => { status.set(format!("{} Reloaded the current Fast model.", error.message)); reload += 1; }
                            Err(error) => status.set(error.message),
                        }
                    });
                },
                    div { class: "field-row",
                        div {
                            label { r#for: "fast-model", "Fast model" }
                            input { id: "fast-model", value: "{fast_form.model}", list: "fast-models", placeholder: "gpt-6-luna (default)",
                                oninput: move |e| if let Some(f) = form.write().as_mut() { f.model = e.value(); } }
                            datalist { id: "fast-models",
                                for model in FAST_SUGGESTIONS { option { value: model } }
                            }
                        }
                        div {
                            label { r#for: "fast-effort", "Fast effort" }
                            select { id: "fast-effort", onchange: move |e| if let Some(f) = form.write().as_mut() { f.effort = e.value(); },
                                option { value: "", selected: fast_form.effort.is_empty(), "low (default)" }
                                for effort in CODEX_EFFORTS {
                                    option { value: effort, selected: fast_form.effort == effort, "{effort}" }
                                }
                            }
                        }
                    }
                    button { r#type: "submit", disabled: busy(), if busy() { "Saving…" } else { "Save Fast model" } }
                }
            } else {
                p { class: "field-help", "This server does not offer a Fast model choice." }
            }
            if !status().is_empty() { p { role: "status", class: "settings-status", "{status}" } }
        }
    }
}
