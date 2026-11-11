//! "Local folder" control in the conversation toolbar (ORK-750). The control
//! lives in JavaScript (`local_files/panel.mjs`, bundled in
//! `encrypted_upload.js`): folder handles, file bytes and the owner's write
//! confirmations never cross the Dioxus bridge. Leaving the conversation, or
//! the session changing, stops serving the folder in this tab.
use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::json;

#[component]
pub fn LocalFolder(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
) -> Element {
    let root = format!("local-folder-{conversation}");
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
        let (conversation, csrf, root) = (conversation.clone(), csrf.clone(), root.clone());
        async move {
            if csrf.is_empty() || !session_scope.read().is_current(owner) {
                return;
            }
            let assets = include_str!("asset_base.mjs").replace("export ", "");
            let config = json!({"conversation":conversation,"csrf":csrf,"root_id":root});
            let script = format!("{assets}\nconst config=await dioxus.recv();let stopped=false;const stop=dioxus.recv().then(()=>{{stopped=true;}});let root;for(let i=0;i<40;i++){{root=document.getElementById(config.root_id);if(root)break;await new Promise(r=>setTimeout(r,25));}}if(!root||stopped)return null;let module;try{{module=await import(uiAssetUrl('encrypted_upload.js'));}}catch{{root.textContent='Local folder controls unavailable. Reload to retry.';return null;}}if(stopped)return null;root.replaceChildren();const panel=module.mountLocalFiles({{conversation:config.conversation,csrf:config.csrf,root}});try{{await stop;}}finally{{panel.close();}}return null;");
            let eval = document::eval(&script);
            if eval.send(config).is_err() {
                return;
            }
            channel.set(Some(eval));
            let _ = eval.await;
        }
    });
    rsx! {
        style { "{include_str!(\"local_files.css\")}" }
        div { id: "{container}", class: "local-folder", "aria-label": "Local folder" }
    }
}
