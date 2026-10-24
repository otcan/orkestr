//! First-run handoff from the desktop app (see `local_setup.mjs`).
use dioxus::prelude::*;

/// The owner-setup token the desktop app handed to this page, if any.
pub async fn take() -> Option<String> {
    let source = include_str!("local_setup.mjs").replace("export function", "function");
    let source = source.replace("export const", "const");
    document::eval(&format!("{source}\nreturn takeLocalSetup(globalThis);"))
        .join::<Option<String>>()
        .await
        .ok()
        .flatten()
}
