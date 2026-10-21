use dioxus::prelude::*;

const SELECTOR: &str = ".conversation-pane > .conversation-scroll";

/// Pins the mounted transcript to its newest message (see `scroll_pin.mjs`)
/// and offers "Jump to latest" while the reader has scrolled up.
#[component]
pub fn ScrollPin() -> Element {
    use_effect(|| {
        let source = include_str!("scroll_pin.mjs").replace("export ", "");
        let script = format!(
            "{source}\nfor (let i = 0; i < 200; i++) {{ const el = document.querySelector('{SELECTOR}'); if (el) {{ installPin(el); break; }} await new Promise(r => setTimeout(r, 25)); }}\nreturn null;"
        );
        spawn(async move {
            let _ = document::eval(&script).await;
        });
    });
    rsx! {
        div { class: "jump-latest-anchor",
            button { class: "jump-latest", r#type: "button", onclick: move |_| {
                let _ = document::eval(&format!("const el = document.querySelector('{SELECTOR}'); if (el) el.scrollTo({{ top: el.scrollHeight, behavior: 'smooth' }}); return null;"));
            }, "Jump to latest ↓" }
        }
    }
}
