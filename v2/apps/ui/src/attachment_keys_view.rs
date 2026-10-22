//! Automatic attachment-key enrollment for this browser (V1 behaviour): runs
//! once per signed-in session. The age identity stays in this browser; the
//! server only learns its public recipient (see `attachments/age.mjs`).
use dioxus::prelude::*;
use serde_json::{json, Value};

#[component]
pub fn AttachmentKeyEnrollment(csrf: String) -> Element {
    let mut state = use_signal(String::new);
    use_future(move || {
        let csrf = csrf.clone();
        async move {
            let source = format!(
                "{}\n{}",
                include_str!("attachments/age.mjs").replace("export ", ""),
                include_str!("attachments/enroll.js")
            );
            let mut eval = document::eval(&source);
            if eval.send(json!({ "csrf": csrf })).is_err() {
                return;
            }
            if let Ok(value) = eval.recv::<Value>().await {
                state.set(if value["ok"] == true {
                    "enrolled".into()
                } else {
                    value["message"].as_str().unwrap_or("failed").to_string()
                });
            }
        }
    });
    // Status for diagnostics only; enrollment needs no owner action.
    rsx! { span { hidden: true, "data-attachment-key": "{state}" } }
}
