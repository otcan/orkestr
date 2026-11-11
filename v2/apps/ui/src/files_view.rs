//! The conversation's Files destination (ORK-786): its saved encrypted file
//! copies on a page of their own, at `#conversation/<id>/files`. Opening it
//! lists once; nothing here polls.
use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;

#[component]
pub fn FilesPage(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let generation = session_scope.read().generation();
    rsx! {
        section { class: "files-page", "aria-labelledby": "files-page-title",
            h2 { id: "files-page-title", "Files" }
            p { class: "field-help",
                "Files saved for this conversation. Files sent with a message stay on that message in Chat. "
                "A folder on this computer is connected from the Chat composer."
            }
            crate::attachments_view::ThreadFiles { key: "files-page-{id}-{generation}", id: id.clone(), csrf, session_scope, onexpired }
        }
    }
}
