//! Local folder writes waiting for the owner (ORK-804), in every tab of the
//! app and on every device: polls the owner-wide list, marks the tab title,
//! shows a notice under the header and gives the conversation list its
//! "Approve write" rows. A write is answered only in the tab serving the
//! folder (`local_files/panel.mjs`); nothing here answers it.
use dioxus::prelude::*;
use orkestr_v2_contracts::{LocalFileWriteWaiting, LocalFileWritesWaiting};
use orkestr_v2_ui::{local_writes, session_scope::SessionScope};
use serde_json::Value;

/// The conversation list's cadence.
const POLL_MS: u32 = 4000;

/// The owner's waiting writes, shared by the header notice and the list.
#[derive(Clone, Copy)]
pub struct WritesWaiting(pub Signal<Vec<LocalFileWriteWaiting>>);

/// The tab title's server-wide mark (`title_marks.mjs`, shared with the
/// folder panel's own marks).
fn mark_title(on: bool) {
    let source = include_str!("title_marks.mjs").replace("export ", "");
    let _ = document::eval(&format!(
        "{source}\nsetTitleMark(document,'waiting',{on});return null;"
    ));
}

/// Polls `GET /api/v2/local-files/waiting` while the owner is signed in.
/// Hidden tabs keep polling, so their title shows a waiting write too.
#[component]
pub fn WritesWaitingPoll(session_scope: Signal<SessionScope>) -> Element {
    let owner = session_scope.read().generation();
    let WritesWaiting(mut waiting) = use_context::<WritesWaiting>();
    let mut mounted = use_signal(|| true);
    use_drop(move || {
        mounted.set(false);
        waiting.set(Vec::new());
        mark_title(false);
    });
    use_future(move || async move {
        let mut marked = false;
        loop {
            if !mounted() || !session_scope.read().is_current(owner) {
                return;
            }
            let result = crate::transport::request::<LocalFileWritesWaiting>(
                "GET",
                "/api/v2/local-files/waiting",
                Value::Null,
                "",
                "",
            )
            .await;
            if !mounted() || !session_scope.read().is_current(owner) {
                return;
            }
            let next = match result {
                Ok(reply) if local_writes::valid(&reply) => Some(reply.conversations),
                // A server without this list (an older release) has nothing to show.
                Err(error) if error.status == 404 => Some(Vec::new()),
                // Signed out: the session handling elsewhere takes over.
                Err(error) if matches!(error.status, 401 | 403) => {
                    waiting.set(Vec::new());
                    mark_title(false);
                    return;
                }
                // A failed read keeps what was last seen; the next one corrects it.
                _ => None,
            };
            if let Some(next) = next {
                if *waiting.peek() != next {
                    waiting.set(next);
                }
                let on = !waiting.peek().is_empty();
                if on != marked {
                    marked = on;
                    mark_title(on);
                }
            }
            crate::transport::sleep(POLL_MS).await;
        }
    });
    rsx! {}
}

/// Under the app header while any write waits: which chat, and that it is
/// answered in the tab where its folder is connected.
#[component]
pub fn WritesWaitingNotice() -> Element {
    let WritesWaiting(waiting) = use_context::<WritesWaiting>();
    let list = waiting.read();
    if list.is_empty() {
        return rsx! {};
    }
    let heading = local_writes::notice_heading(&list);
    let lines = local_writes::notice_lines(&list);
    rsx! {
        section { class: "write-waiting", role: "status", "aria-live": "polite", "aria-label": "{heading}",
            strong { class: "write-waiting-heading", "{heading}" }
            div { class: "write-waiting-lines",
                for (i, line) in lines.into_iter().enumerate() { p { key: "{i}", "{line}" } }
            }
        }
    }
}
