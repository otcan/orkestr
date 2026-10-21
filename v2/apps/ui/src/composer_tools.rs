use dioxus::prelude::*;
use orkestr_v2_contracts::MessageAttachmentReceipt;
use orkestr_v2_ui::composer_attachments::{self, Attached};
use serde::Deserialize;
use serde_json::{json, Value};

/// Enter sends, Shift+Enter inserts a newline, never while an IME composes
/// (see `composer_keys.mjs`). Installs once on the textarea with `id`.
#[component]
pub fn EnterSend(id: String) -> Element {
    use_effect(move || {
        let source = include_str!("composer_keys.mjs").replace("export ", "");
        let script = format!(
            "{source}\nconst id = await dioxus.recv();\nfor (let i = 0; i < 200; i++) {{ const el = document.getElementById(id); if (el) {{ installEnterSend(el); break; }} await new Promise(r => setTimeout(r, 25)); }}\nreturn null;"
        );
        let id = id.clone();
        spawn(async move {
            let eval = document::eval(&script);
            let _ = eval.send(json!(id));
            let _ = eval.await;
        });
    });
    rsx! {}
}

#[derive(Clone, Debug, PartialEq)]
pub enum AttachTarget {
    /// Native conversation id.
    Native(String),
    /// Linked V1 thread id.
    V1(String),
}
impl AttachTarget {
    fn path(&self) -> String {
        match self {
            Self::Native(id) => format!("/api/v2/conversations/{id}/message-attachments"),
            Self::V1(thread) => format!("/api/v2/v1-threads/{thread}/uploads"),
        }
    }
}

#[derive(Deserialize)]
struct Picked {
    #[serde(default)]
    files: Vec<Value>,
    error: Option<String>,
}

fn helper(call: &str) -> String {
    let source = include_str!("attach_files.mjs").replace("export ", "");
    format!("{source}\n{call}")
}

/// Attach (file picker) and Paste text (long text as a `.txt` file). Files
/// upload at once; the composer sends them with the next message.
#[component]
pub fn AttachTools(
    target: AttachTarget,
    csrf: String,
    attached: Signal<Vec<Attached>>,
    disabled: bool,
) -> Element {
    let mut busy = use_signal(|| false);
    let mut status = use_signal(String::new);
    let mut pasting = use_signal(|| false);
    let mut pasted = use_signal(String::new);
    let mut mounted = use_signal(|| true);
    use_drop(move || mounted.set(false));
    let upload = {
        let target = target.clone();
        let csrf = csrf.clone();
        move |files: Vec<Value>| {
            let (target, csrf) = (target.clone(), csrf.clone());
            spawn(async move {
                busy.set(true);
                status.set("Uploading…".into());
                let result = async {
                    let key = crate::transport::key().await?;
                    crate::transport::request::<MessageAttachmentReceipt>(
                        "POST",
                        &target.path(),
                        json!({"request_key": key, "files": files}),
                        &csrf,
                        "",
                    )
                    .await
                }
                .await;
                if !mounted() {
                    return;
                }
                busy.set(false);
                match result {
                    Ok(receipt) if receipt.is_valid() => {
                        attached
                            .write()
                            .extend(composer_attachments::from_receipt(receipt));
                        status.set(String::new());
                    }
                    Ok(_) => status.set("Upload reply could not be verified.".into()),
                    Err(error) => status.set(format!("Not attached: {}", error.message)),
                }
            });
        }
    };
    let pick_upload = upload.clone();
    let paste_upload = upload.clone();
    rsx! {
        div { class: "composer-tools",
            button { r#type: "button", class: "tool-button", disabled: disabled || busy(), "aria-label": "Attach a file or image",
                onclick: move |_| {
                    let upload = pick_upload.clone();
                    spawn(async move {
                        let picked = document::eval(&helper("return await pick(document);")).join::<Picked>().await;
                        match picked {
                            Ok(Picked { error: Some(error), .. }) => status.set(error),
                            Ok(Picked { files, .. }) if !files.is_empty() => upload(files),
                            Ok(_) => {}
                            Err(_) => status.set("Files could not be read.".into()),
                        }
                    });
                },
                svg { class: "tool-icon", "aria-hidden": "true", view_box: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", stroke_width: "2", stroke_linecap: "round", stroke_linejoin: "round",
                    path { d: "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" }
                }
                "Attach"
            }
            button { r#type: "button", class: "tool-button", disabled: disabled || busy(), "aria-expanded": "{pasting}",
                onclick: move |_| pasting.set(!pasting()), "Paste text" }
            for item in attached.read().iter().cloned() {
                span { key: "{item.summary.attachment_id}", class: "attachment-chip",
                    span { class: "chip-name", "{item.summary.filename}" }
                    span { class: "chip-size", "{composer_attachments::size(item.summary.byte_length)}" }
                    button { r#type: "button", class: "chip-remove", "aria-label": "Remove {item.summary.filename}",
                        onclick: move |_| { let id = item.summary.attachment_id.clone(); attached.write().retain(|a| a.summary.attachment_id != id); }, "×" }
                }
            }
            if !status().is_empty() { span { class: "tool-status", role: "status", "{status}" } }
        }
        if pasting() {
            div { class: "paste-panel",
                label { r#for: "paste-text", "Paste long text; it is sent as a text file" }
                textarea { id: "paste-text", rows: 6, value: "{pasted}", oninput: move |e| pasted.set(e.value()) }
                div { class: "paste-actions",
                    button { r#type: "button", disabled: busy() || pasted().trim().is_empty(), onclick: move |_| {
                        let text = pasted();
                        let upload = paste_upload.clone();
                        spawn(async move {
                            let eval = document::eval(&helper("return pastedText(await dioxus.recv());"));
                            let _ = eval.send(json!(text));
                            match eval.join::<Value>().await {
                                Ok(file) => { upload(vec![file]); pasted.set(String::new()); pasting.set(false); }
                                Err(_) => status.set("Text could not be attached.".into()),
                            }
                        });
                    }, "Attach as text file" }
                    button { r#type: "button", onclick: move |_| { pasted.set(String::new()); pasting.set(false); }, "Cancel" }
                }
            }
        }
    }
}
