use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc};

#[component]
pub fn ThreadFiles(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut page = use_signal(|| Value::Null);
    let mut manifest = use_signal(|| Value::Null);
    let mut notice = use_signal(|| "Loading thread files…".to_string());
    let mut busy = use_signal(|| true);
    let mut pending = use_signal(|| false);
    let mut channel = use_signal(|| None::<document::Eval>);
    let active = use_hook(|| Rc::new(Cell::new(true)));
    let dropped = active.clone();
    let owner = session_scope.read().generation();
    let file_id = format!("thread-file-{id}");
    let archive_id = format!("thread-archive-{id}");
    use_drop(move || {
        dropped.set(false);
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    use_future(move || {
        let id = id.clone();
        let csrf = csrf.clone();
        let active = active.clone();
        async move {
            let source = format!(
                "{}\n{}\n{}",
                include_str!("attachments/integrity.mjs").replace("export ", ""),
                include_str!("attachments/client.mjs")
                    .replace(
                        "import {referenceFor,verifyBytes} from './integrity.mjs';",
                        ""
                    )
                    .replace("export ", ""),
                include_str!("attachments/bridge.js")
            );
            let eval = document::eval(&source);
            if eval.send(json!({"conversation":id,"csrf":csrf})).is_err() {
                notice.set("Files unavailable. Refresh to reconnect.".into());
                busy.set(false);
                return;
            }
            channel.set(Some(eval));
            let mut eval = eval;
            while let Ok(value) = eval.recv::<Value>().await {
                if !active.get() || !session_scope.read().is_current(owner) {
                    let _ = eval.send(json!({"stop":true}));
                    return;
                }
                if value["status"] == 401 {
                    onexpired.call(());
                    return;
                }
                if value.get("page").is_some() {
                    page.set(value["page"].clone());
                }
                if value.get("manifest").is_some() {
                    manifest.set(value["manifest"].clone());
                }
                notice.set(
                    value["notice"]
                        .as_str()
                        .unwrap_or("Files unavailable")
                        .to_string(),
                );
                pending.set(value["pending"].as_bool().unwrap_or(false));
                busy.set(false);
            }
            if active.get() && session_scope.read().is_current(owner) {
                notice.set("Files disconnected. Refresh to reconnect.".into());
                busy.set(false);
            }
        }
    });
    let mut send = move |action: Value| {
        if busy() || !session_scope.read().is_current(owner) {
            return;
        }
        if let Some(eval) = channel.read().as_ref() {
            if eval.send(action).is_ok() {
                busy.set(true);
            }
        }
    };
    let manifests = page.read()["manifests"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let references = manifest.read()["references"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let next = page.read()["next_after_id"].as_str().map(str::to_string);
    rsx! {
        section { "aria-label":"Thread files",
            h3 { "Thread files" }
            p { "Save a private copy for this conversation. Files are not attached to messages or sent to the assistant." }
            p {role:"status", "{notice}"}
            button {disabled:busy(),onclick:move |_|send(json!({"kind":"list"})),"Refresh files"}
            if pending() {
                p {"A file request is unconfirmed. Retry uses the original file copy and request."}
                button {disabled:busy(),onclick:move |_|send(json!({"kind":"retry"})),"Retry original file request"}
            }
            label {r#for:"{file_id}","File to save (up to 16 MiB)"}
            input {id:"{file_id}",r#type:"file",disabled:busy()||pending()}
            button {disabled:busy()||pending()||page.read().is_null(),onclick:move |_|send(json!({"kind":"upload","input":file_id})),"Save file copy"}
            details {summary {"Import a file-copy archive"}
                p {"Choose a previously exported JSON archive. Copies receive new identities; this does not send messages."}
                input {id:"{archive_id}",r#type:"file",accept:"application/json,.json",disabled:busy()||pending(),"aria-label":"File-copy archive"}
                button {disabled:busy()||pending()||page.read().is_null(),onclick:move |_|send(json!({"kind":"import","input":archive_id})),"Import file copies"}
            }
            ul {
                for item in manifests {
                    li {key:r#"{item["manifest_id"]}"#,
                        button {disabled:busy()||pending(),onclick:move |_|send(json!({"kind":"open","id":item["manifest_id"]})),
                            r#"Open saved copy: {item["references"][0]["filename"].as_str().unwrap_or("Empty file collection")}"#}
                    }
                }
            }
            if let Some(next)=next {button {disabled:busy()||pending(),onclick:move |_|send(json!({"kind":"list","after":next})),"Next file collections"}}
            if !manifest.read().is_null() {
                button {disabled:busy()||pending(),onclick:move |_|send(json!({"kind":"export","manifest":manifest()})),"Export file-copy archive"}
                ul {for reference in references {
                    li {key:r#"{reference["reference_id"]}"#,
                        strong {r#"{reference["filename"].as_str().unwrap_or("Saved file")}"#}
                        p {r#"{reference["byte_length"]} bytes"#}
                        if reference["state"]=="available" {
                            button {disabled:busy()||pending(),onclick:{let r=reference.clone();move |_|send(json!({"kind":"download","manifest":manifest(),"reference":r["reference_id"]}))},"Verify and download"}
                            button {disabled:busy()||pending(),onclick:{let r=reference.clone();move |_|send(json!({"kind":"remove","manifest":manifest(),"reference":r["reference_id"]}))},"Remove file bytes"}
                        } else if reference["state"]=="removed" {p {"File removed — saved reference only."}}
                        else {p {"Saved reference only — file unavailable."}}
                        details {summary {"File reference details"}p {r#"{reference["reference_id"]}"#}}
                    }
                }}
            }
        }
    }
}
