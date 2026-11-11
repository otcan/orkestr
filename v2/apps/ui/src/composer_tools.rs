use dioxus::prelude::*;
use orkestr_v2_contracts::MessageAttachmentReceipt;
use orkestr_v2_ui::composer_attachments::{self, Attached};
use orkestr_v2_ui::upload_progress::UploadProgress;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc};

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
    fn limit_hint(&self) -> &'static str {
        match self {
            Self::Native(_) => "Up to 1 GB per file.",
            Self::V1(_) => "This linked chat accepts up to 16 MiB per message.",
        }
    }

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
    #[serde(default)]
    receipts: Vec<MessageAttachmentReceipt>,
    error: Option<String>,
    progress: Option<UploadProgress>,
}

fn helper(call: &str) -> String {
    let source = include_str!("attach_files.mjs").replace("export ", "");
    format!("{source}\nconst describeFiles=describe;\n{call}")
}

fn file_helper(call: &str, target: &AttachTarget, csrf: &str) -> String {
    match target {
        AttachTarget::V1(_) => helper(call),
        AttachTarget::Native(conversation) => {
            let source = include_str!("attach_files.mjs").replace("export ", "");
            let assets = include_str!("asset_base.mjs").replace("export ", "");
            let context = json!({"conversation":conversation,"csrf":csrf});
            // Open the picker before loading the uploader. Optional browser
            // facilities must not prevent the owner selecting a file.
            format!("{source}\n{assets}\nconst describeFiles=async files=>{{try{{const module=await import(uiAssetUrl('encrypted_upload.js')); return await module.nativeDescribe({context},{{progress:value=>dioxus.send({{progress:value}})}})(files);}}catch{{return {{error:'Encrypted uploads are unavailable. Reload the page and try again.'}};}}}};\n{call}")
        }
    }
}

/// Runs `call` against the loaded encrypted uploader (`encrypted_composer.mjs`).
fn uploader_call(call: &str) -> String {
    let assets = include_str!("asset_base.mjs").replace("export ", "");
    format!("{assets}\nconst module=await import(uiAssetUrl('encrypted_upload.js'));return await module.{call};")
}

/// Stops one in-flight native upload; the uploader then discards it on the server.
fn cancel_script(upload_id: &str) -> String {
    uploader_call(&format!("cancelUpload({})", json!(upload_id)))
}

/// Discards an attached, unsent native upload on the server.
fn discard_script(conversation: &str, csrf: &str, upload_id: &str) -> String {
    let context = json!({"conversation":conversation,"csrf":csrf});
    uploader_call(&format!("discardUpload({context},{})", json!(upload_id)))
}

/// Upload ids the owner cancelled in this composer, newest last.
const CANCELLED_KEPT: usize = 16;

fn paste_helper(target: &AttachTarget, csrf: &str, input: &str) -> String {
    match target {
        AttachTarget::V1(_) => helper("return {files:[pastedText(await dioxus.recv())]};"),
        AttachTarget::Native(conversation) => {
            let assets = include_str!("asset_base.mjs").replace("export ", "");
            let context = json!({"conversation":conversation,"csrf":csrf});
            let input = json!(input);
            format!("{assets}\nconst module=await import(uiAssetUrl('encrypted_upload.js')); dioxus.send(await module.nativePaste({context},document.getElementById({input}),{{progress:value=>dioxus.send({{progress:value}})}}));return null;")
        }
    }
}

async fn pick_with_progress(
    script: &str,
    mut progress: Signal<Option<UploadProgress>>,
    mounted: Signal<bool>,
) -> Result<Picked, ()> {
    let mut eval = document::eval(script);
    while let Ok(picked) = eval.recv::<Picked>().await {
        if !mounted() {
            return Err(());
        }
        if let Some(value) = picked.progress.as_ref() {
            if value.is_valid() {
                progress.set(Some(value.clone()));
            }
            continue;
        }
        return Ok(picked);
    }
    Err(())
}

/// Verified receipts join the draft. A receipt can race the Cancel that
/// stopped its upload: the owner's Cancel wins and that upload is discarded.
fn accept_receipts(
    receipts: Vec<MessageAttachmentReceipt>,
    mut attached: Signal<Vec<Attached>>,
    cancelled: Signal<Vec<String>>,
    discard: Callback<String>,
) -> bool {
    if receipts.iter().any(|r| !r.is_valid()) {
        return false;
    }
    let cancelled = cancelled.peek().clone();
    for receipt in receipts {
        if let Some(file) = receipt
            .attachments
            .iter()
            .find(|file| cancelled.contains(&file.attachment_id))
        {
            discard.call(file.attachment_id.clone());
            continue;
        }
        attached
            .write()
            .extend(composer_attachments::from_receipt(receipt));
    }
    true
}

/// The upload bar: the current file's progress (with Cancel), nothing once
/// the owner cancelled that file, or a pending bar while a pick is prepared.
fn upload_bar(
    current: Option<UploadProgress>,
    busy: bool,
    cancelled: &[String],
    oncancel: Callback<String>,
) -> Element {
    match current {
        Some(value)
            if value
                .upload_id
                .as_ref()
                .is_some_and(|id| cancelled.contains(id)) =>
        {
            rsx! {}
        }
        Some(value) => rsx! {
            crate::upload_progress_view::UploadProgressView { value, oncancel }
        },
        None if busy => rsx! {
            progress { "aria-label": "Preparing file upload", class: "upload-progress-pending" }
        },
        None => rsx! {},
    }
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
    let mut progress = use_signal(|| None::<UploadProgress>);
    let mut pasting = use_signal(|| false);
    let mut pasted = use_signal(String::new);
    let mut mounted = use_signal(|| true);
    use_drop(move || mounted.set(false));
    let mut cancelled = use_signal(Vec::<String>::new);
    // Remove (an attached, unsent file): a native upload is also discarded on
    // the server. A linked V1 chat keeps its upload; the chip just leaves.
    let discard = {
        let (target, csrf) = (target.clone(), csrf.clone());
        use_callback(move |upload_id: String| {
            if let AttachTarget::Native(conversation) = &target {
                let script = discard_script(conversation, &csrf, &upload_id);
                spawn(async move {
                    let _ = document::eval(&script).await;
                });
            }
        })
    };
    // Cancel (a file still uploading): its bar goes at once and its receipt
    // is never accepted; the uploader aborts the transfer and discards it.
    let cancel = use_callback(move |upload_id: String| {
        {
            let mut ids = cancelled.write();
            if !ids.contains(&upload_id) {
                ids.push(upload_id.clone());
            }
            let excess = ids.len().saturating_sub(CANCELLED_KEPT);
            ids.drain(..excess);
        }
        let script = cancel_script(&upload_id);
        spawn(async move {
            let _ = document::eval(&script).await;
        });
    });
    let upload = {
        let target = target.clone();
        let csrf = csrf.clone();
        move |files: Vec<Value>| {
            let (target, csrf) = (target.clone(), csrf.clone());
            spawn(async move {
                busy.set(true);
                progress.set(None);
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
    let pick_target = target.clone();
    let pick_csrf = csrf.clone();
    let paste_upload = upload.clone();
    let paste_target = target.clone();
    let paste_csrf = csrf.clone();
    let limit_hint = target.limit_hint();
    // Files dropped onto the conversation or images pasted into the composer
    // upload like Attach. The listener lives as long as this component.
    let tools_id = format!(
        "attach-tools-{}",
        target
            .path()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
    );
    let gate = use_hook(|| Rc::new(Cell::new(false)));
    let paste_id = format!("paste-text-{tools_id}");
    let paste_input = paste_id.clone();
    gate.set(disabled);
    let mut drops = use_signal(|| None::<document::Eval>);
    use_drop(move || {
        if let Some(eval) = drops.peek().as_ref() {
            let _ = eval.send(json!({"stop": true}));
        }
    });
    {
        let id = tools_id.clone();
        let gate = gate.clone();
        let upload = upload.clone();
        let target = target.clone();
        let csrf = csrf.clone();
        use_future(move || {
            let (id, gate, upload, target, csrf) = (
                id.clone(),
                gate.clone(),
                upload.clone(),
                target.clone(),
                csrf.clone(),
            );
            async move {
                let mut eval = document::eval(&file_helper(
                    "return await watchDrops(document, await dioxus.recv(), dioxus, describeFiles);",&target,&csrf,
                ));
                if eval.send(json!(id)).is_err() {
                    return;
                }
                drops.set(Some(eval));
                while let Ok(picked) = eval.recv::<Picked>().await {
                    if !mounted() {
                        return;
                    }
                    if let Some(value) = picked.progress.as_ref() {
                        if value.is_valid() {
                            busy.set(value.is_active());
                            status.set(String::new());
                            progress.set(Some(value.clone()));
                        }
                        continue;
                    }
                    if !picked.receipts.is_empty()
                        || (picked.error.is_none() && picked.files.is_empty())
                    {
                        busy.set(false);
                        progress.set(None);
                        status.set(String::new());
                    }
                    if !accept_receipts(picked.receipts.clone(), attached, cancelled, discard) {
                        progress.set(None);
                        status.set("Upload reply could not be verified.".into());
                        continue;
                    }
                    match picked {
                        Picked {
                            error: Some(error), ..
                        } => status.set(format!("Not attached: {error}")),
                        Picked { files, .. } if files.is_empty() => {}
                        _ if gate.get() || busy() => status.set(
                            "Not attached: wait for the current send or upload to finish.".into(),
                        ),
                        Picked { files, .. } => upload(files),
                    }
                }
            }
        });
    }
    rsx! {
        div { class: "composer-tools", id: "{tools_id}",
            button { r#type: "button", class: "tool-button", disabled: disabled || busy(), "aria-label": "Attach a file or image",
                onclick: move |_| {
                    let upload = pick_upload.clone();
                    let target=pick_target.clone();let csrf=pick_csrf.clone();
                    spawn(async move {
                        busy.set(true);progress.set(None);status.set("Choose files to attach…".into());
                        let script=file_helper("dioxus.send(await pick(document, describeFiles));return null;",&target,&csrf);
                        let picked = pick_with_progress(&script,progress,mounted).await;
                        if !mounted() {return;}
                        busy.set(false);status.set(String::new());
                        if let Ok(picked)=&picked {if !accept_receipts(picked.receipts.clone(),attached,cancelled,discard){progress.set(None);status.set("Upload reply could not be verified.".into());return;}}
                        match picked {
                            Ok(Picked { error: Some(error), .. }) => status.set(error),
                            Ok(Picked { files, .. }) if !files.is_empty() => upload(files),
                            Ok(_) => {progress.set(None);}
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
                    button { r#type: "button", class: "chip-remove upload-control", "aria-label": "Remove {item.summary.filename}",
                        onclick: move |_| { let id = item.summary.attachment_id.clone(); attached.write().retain(|a| a.summary.attachment_id != id); discard.call(id); }, "Remove" }
                }
            }
            span { class: "drop-hint", "aria-hidden": "true", "or drop files here" }
            span { class: "attachment-limit", "{limit_hint}" }
            {upload_bar(progress(), busy(), &cancelled.read(), cancel)}
            if !status().is_empty() { span { class: "tool-status", role: "status", "{status}" } }
        }
        if pasting() {
            div { class: "paste-panel",
                label { r#for: "{paste_id}", "Paste long text; it is sent as a text file" }
                textarea { id: "{paste_id}", rows: 6, value: "{pasted}", disabled: busy(), oninput: move |e| pasted.set(e.value()) }
                div { class: "paste-actions",
                    button { r#type: "button", disabled: busy() || pasted().trim().is_empty(), onclick: move |_| {
                        let upload = paste_upload.clone();
                        let target = paste_target.clone();
                        let csrf = paste_csrf.clone();
                        let input = paste_input.clone();
                        busy.set(true);
                        status.set("Uploading…".into());
                        spawn(async move {
                            let script = paste_helper(&target, &csrf, &input);
                            let result = if matches!(target, AttachTarget::V1(_)) {
                                let eval = document::eval(&script);
                                let _ = eval.send(json!(pasted()));
                                eval.join::<Picked>().await.map_err(|_| ())
                            } else {
                                pick_with_progress(&script, progress, mounted).await
                            };
                            if !mounted() { return; }
                            busy.set(false);
                            progress.set(None);
                            match result {
                                Ok(picked) if !accept_receipts(picked.receipts.clone(), attached, cancelled, discard) => status.set("Upload reply could not be verified.".into()),
                                Ok(Picked { error: Some(error), .. }) => status.set(error),
                                // Cancelled: keep the text for another try.
                                Ok(Picked { files, receipts, .. }) if files.is_empty() && receipts.is_empty() => status.set(String::new()),
                                Ok(Picked { files, .. }) => {
                                    status.set(String::new());
                                    if !files.is_empty() { upload(files); }
                                    pasted.set(String::new());
                                    pasting.set(false);
                                }
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
