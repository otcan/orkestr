//! A visible Copy button on every message and on each code or quote block.
//! It is a real button (Tab, then Enter or Space), shows a short "Copied"
//! confirmation that is also announced politely, and falls back to the legacy
//! copy command where the Clipboard API is unavailable (`copy_text.mjs`).
//! It does nothing until pressed: one signal per button, no per-message work.
use dioxus::prelude::*;
use serde_json::json;

/// How long "Copied" (or "Copy failed") stays before the button resets.
const CONFIRM_MS: u32 = 1600;

/// Put `text` on the clipboard; whether the browser confirmed it.
pub async fn copy_text(text: String) -> bool {
    let script = format!(
        "{}\nreturn await copyText(await dioxus.recv());",
        include_str!("copy_text.mjs").replace("export ", "")
    );
    let eval = document::eval(&script);
    if eval.send(json!(text)).is_err() {
        return false;
    }
    eval.join::<bool>().await.unwrap_or(false)
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    Ready,
    Copied,
    Failed,
}

#[component]
pub fn CopyButton(
    /// Exactly what goes on the clipboard.
    text: String,
    /// The button's accessible name, for example "Copy message".
    label: &'static str,
    #[props(default)] class: &'static str,
) -> Element {
    let mut state = use_signal(|| State::Ready);
    let mut presses = use_signal(|| 0_u32);
    let (shown, slug) = match state() {
        State::Ready => ("", "ready"),
        State::Copied => ("Copied", "copied"),
        State::Failed => ("Copy failed", "failed"),
    };
    let name = if shown.is_empty() { label } else { shown };
    rsx! {
        span { class: "copy-control {class}",
            button { r#type: "button", class: "copy-button", "aria-label": "{name}", title: "{label}", "data-copy-state": "{slug}",
                onclick: move |event: MouseEvent| {
                    event.stop_propagation();
                    let text = text.clone();
                    let press = *presses.peek() + 1;
                    presses.set(press);
                    spawn(async move {
                        let copied = copy_text(text).await;
                        state.set(if copied { State::Copied } else { State::Failed });
                        crate::transport::sleep(CONFIRM_MS).await;
                        if *presses.peek() == press {
                            state.set(State::Ready);
                        }
                    });
                },
                svg { class: "copy-icon", "aria-hidden": "true", view_box: "0 0 24 24", width: "14", height: "14", fill: "none", stroke: "currentColor", stroke_width: "2", stroke_linecap: "round", stroke_linejoin: "round",
                    if state() == State::Copied {
                        path { d: "M20 6 9 17l-5-5" }
                    } else {
                        rect { x: "9", y: "9", width: "12", height: "12", rx: "2" }
                        path { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }
                    }
                }
                if !shown.is_empty() { span { class: "copy-button-text", "{shown}" } }
            }
            span { class: "visually-hidden", role: "status", "{shown}" }
        }
    }
}
