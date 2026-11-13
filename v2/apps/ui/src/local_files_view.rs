//! A conversation's local folder (ORK-750, ORK-786, ORK-809). The control
//! lives in JavaScript (`local_files/panel.mjs`, bundled in
//! `encrypted_upload.js`): folder handles, file bytes and write content never
//! cross the Dioxus bridge. Its full controls and state in words render here,
//! in the Files panel's "Your folder"; its activity log goes to `log_root`;
//! the composer's one folder chip goes to `chip_root` and links to the Files
//! panel (`files_href`) while a folder is connected. Leaving the
//! conversation, or the session changing, stops serving the folder in this tab.
use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::json;

#[component]
pub fn LocalFolder(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    /// Element id for the folder activity log; defaults to inside the control.
    #[props(default)]
    log_root: Option<String>,
    /// Element id of the composer's folder chip, if the composer has one.
    #[props(default)]
    chip_root: Option<String>,
    /// Where the chip of a connected folder leads (the Files panel).
    #[props(default)]
    files_href: Option<String>,
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
        let (conversation, csrf, root, log_root, chip_root, files_href) = (
            conversation.clone(),
            csrf.clone(),
            root.clone(),
            log_root.clone(),
            chip_root.clone(),
            files_href.clone(),
        );
        async move {
            if csrf.is_empty() || !session_scope.read().is_current(owner) {
                return;
            }
            let assets = include_str!("asset_base.mjs").replace("export ", "");
            let config = json!({"conversation":conversation,"csrf":csrf,"root_id":root,"log_id":log_root,"chip_id":chip_root,"files_href":files_href});
            let script = format!("{assets}\nconst config=await dioxus.recv();let stopped=false;const stop=dioxus.recv().then(()=>{{stopped=true;}});let root;for(let i=0;i<40;i++){{root=document.getElementById(config.root_id);if(root)break;await new Promise(r=>setTimeout(r,25));}}if(!root||stopped)return null;let module;try{{module=await import(uiAssetUrl('encrypted_upload.js'));}}catch{{root.textContent='Local folder controls unavailable. Reload to retry.';return null;}}if(stopped)return null;root.replaceChildren();const logRoot=config.log_id?document.getElementById(config.log_id):null;const chipRoot=config.chip_id?document.getElementById(config.chip_id):null;const panel=module.mountLocalFiles({{conversation:config.conversation,csrf:config.csrf,root,logRoot,chipRoot,filesHref:config.files_href}});try{{await stop;}}finally{{panel.close();}}return null;");
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
        div { id: "{container}", class: "local-folder", role: "group", "aria-label": "Your folder",
            span { class: "local-folder-state", "data-state": "checking", "Checking folder access…" }
        }
    }
}
