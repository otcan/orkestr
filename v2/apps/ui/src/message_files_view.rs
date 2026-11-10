use dioxus::prelude::*;
use orkestr_v2_ui::{message_file_refs, session_scope::SessionScope};
use serde_json::json;
#[component]
pub fn MessageFiles(
    conversation: String,
    message: String,
    text: String,
    session_scope: Signal<SessionScope>,
) -> Element {
    let files = message_file_refs::references(&text);
    let has_files = !files.is_empty();

    let root = format!("message-files-{message}");
    let container = root.clone();
    let mut channel = use_signal(|| None::<document::Eval>);
    use_drop(move || {
        if let Some(eval) = channel.peek().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    let owner = use_hook(move || session_scope.read().generation());
    use_effect(move || {
        if !session_scope.read().is_current(owner) {
            if let Some(eval) = channel.peek().as_ref() {
                let _ = eval.send(json!({"stop":true}));
            }
        }
    });
    use_future(move || {
        let (conversation, files, root) = (conversation.clone(), files.clone(), root.clone());
        async move {
            if files.is_empty() || !session_scope.read().is_current(owner) {
                return;
            }
            let assets = include_str!("asset_base.mjs").replace("export ", "");
            let config = json!({"conversation":conversation,"files":files,"root_id":root});
            let script=format!("{assets}\nconst config=await dioxus.recv();let stopped=false;const stop=dioxus.recv().then(()=>{{stopped=true;}});let root;for(let i=0;i<40;i++){{root=document.getElementById(config.root_id);if(root)break;await new Promise(r=>setTimeout(r,25));}}if(!root||stopped)return null;let module;try{{module=await import(uiAssetUrl('encrypted_upload.js'));}}catch{{root.textContent='Attachment controls unavailable. Reload to retry.';return null;}}if(stopped)return null;root.replaceChildren();const viewer=module.mountMessageFiles({{...config,root}});try{{await stop;}}finally{{viewer.close();}}return null;");
            let eval = document::eval(&script);
            if eval.send(config).is_err() {
                return;
            }
            channel.set(Some(eval));
            let _ = eval.await;
        }
    });
    if !has_files {
        return rsx! {};
    }
    rsx! {style { "{include_str!(\"message_files.css\")}" } div{id:"{container}",class:"message-files","aria-label":"Message attachments", "Loading attachment controls…"}}
}
