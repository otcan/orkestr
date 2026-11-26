//! The Files panel's folder view: the folder this chat's agent works in on
//! the host, read-only (`docs/v2/workspace-files.md`). Folders first, then
//! files, newest first; a folder opens in place, breadcrumbs lead back; a file
//! opens a preview (text or image) with Download. Nothing here can write,
//! rename or delete. Every read is the server's owner-only folder routes.
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    WorkspaceEntry, WorkspaceEntryKind, WorkspaceFilePreview, WorkspaceLinkTarget,
    WorkspaceListing, WorkspacePreview, WorkspaceRootKind, WorkspaceState,
};
use orkestr_v2_ui::{message_time, session_scope::SessionScope, workspace_files as files};
use serde_json::Value;

#[component]
pub fn WorkspaceFiles(
    conversation: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut path = use_signal(String::new);
    let mut reload = use_signal(|| 0_u32);
    let mut listing = use_signal(|| None::<WorkspaceListing>);
    let mut failure = use_signal(|| None::<String>);
    let mut selected = use_signal(|| None::<String>);
    // The shared default workspace holds every unpinned chat's files: listed
    // only when the owner asks, never as this chat's own.
    let mut show_shared = use_signal(|| false);
    let now = crate::message_time_view::use_now();
    let read = conversation.clone();
    use_resource(move || {
        let current = path();
        let _ = reload();
        let conversation = read.clone();
        async move {
            let result = crate::transport::request::<WorkspaceListing>(
                "GET",
                &files::list_url(&conversation, &current),
                Value::Null,
                "",
                "",
            )
            .await;
            if !session_scope.read().is_current(owner) || *path.peek() != current {
                return;
            }
            match result {
                Ok(value) if value.is_valid() && value.path == current => {
                    listing.set(Some(value));
                    failure.set(None);
                }
                Ok(_) => failure.set(Some("The folder listing could not be verified.".into())),
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => failure.set(Some(error.message)),
            }
        }
    });
    let mut open = move |target: String| {
        selected.set(None);
        failure.set(None);
        path.set(target);
    };
    let shown = listing.read().clone().filter(|l| l.path == path());
    let now_ms = now();
    rsx! {
        style { "{include_str!(\"workspace_files.css\")}" }
        div { class: "workspace-files",
            if let Some(list) = shown {
                {
                    let (title, note) = files::root_heading(&list);
                    let kind = match list.root_kind { Some(WorkspaceRootKind::SharedDefault) => "shared_default", Some(WorkspaceRootKind::Conversation) => "conversation", None => "" };
                    rsx! {
                        p { class: "workspace-root", "data-root-kind": "{kind}", "{title}" }
                        if let Some(note) = note { p { class: "files-drawer-note workspace-shared-note", "{note}" } }
                    }
                }
                if let Some(text) = files::state_text(list.state) {
                    p { class: "files-empty workspace-state", role: "status", "data-state": state_slug(list.state), "{text}" }
                    if list.state == WorkspaceState::Unavailable {
                        button { r#type: "button", class: "workspace-retry", onclick: move |_| reload += 1, "Try again" }
                    }
                } else if matches!(list.root_kind, Some(WorkspaceRootKind::SharedDefault)) && !show_shared() {
                    button { r#type: "button", class: "workspace-show-shared", onclick: move |_| show_shared.set(true), "Show files of all chats" }
                } else {
                    nav { class: "workspace-crumbs", "aria-label": "Folder path",
                        for (index, (label, target)) in files::crumbs(list.root_name.as_deref().unwrap_or("Folder"), &list.path).into_iter().enumerate() {
                            if target == list.path {
                                span { key: "{index}", class: "workspace-crumb", "aria-current": "page", "{label}" }
                            } else {
                                span { key: "{index}", class: "workspace-crumb-step",
                                    button { r#type: "button", class: "workspace-crumb", onclick: move |_| open(target.clone()), "{label}" }
                                    span { class: "workspace-crumb-sep", "aria-hidden": "true", "/" }
                                }
                            }
                        }
                    }
                    if list.entries.is_empty() {
                        p { class: "files-empty", "This folder is empty." }
                    }
                    ul { class: "workspace-entries", "aria-label": "Files and folders",
                        for entry in list.entries.iter() {
                            EntryRow { key: "{entry.name}", here: list.path.clone(), entry: entry.clone(), now_ms, selected: selected(),
                                onopen: move |(target, folder): (String, bool)| {
                                    if folder { open(target); } else { selected.set(Some(target)); }
                                }
                            }
                        }
                    }
                    if let Some(note) = files::hidden_note(list.hidden) { p { class: "files-drawer-note workspace-hidden", "{note}" } }
                    if list.truncated { p { class: "files-drawer-note", "Only the newest 1000 entries are shown." } }
                }
            } else if let Some(message) = failure() {
                p { class: "files-empty", role: "alert", "{message}" }
                button { r#type: "button", class: "workspace-retry", onclick: move |_| reload += 1, "Try again" }
            } else {
                p { class: "files-empty", role: "status", "Loading folder…" }
            }
            if let Some(file) = selected() {
                FilePreview { key: "{file}", conversation: conversation.clone(), path: file.clone(), session_scope, onexpired,
                    onclose: move |_| selected.set(None) }
            }
        }
    }
}

fn state_slug(state: WorkspaceState) -> &'static str {
    match state {
        WorkspaceState::Ready => "ready",
        WorkspaceState::NotConfigured => "not_configured",
        WorkspaceState::Unavailable => "unavailable",
        WorkspaceState::Missing => "missing",
    }
}

#[component]
fn EntryRow(
    entry: WorkspaceEntry,
    here: String,
    now_ms: i64,
    /// The file the panel previews, if any.
    selected: Option<String>,
    onopen: EventHandler<(String, bool)>,
) -> Element {
    let target = files::child(&here, &entry.name);
    let current = selected.as_deref() == Some(target.as_str());
    let folder = entry.opens_as_folder();
    let openable = folder || entry.opens_as_file();
    let kind = match entry.kind {
        WorkspaceEntryKind::Dir => "dir",
        WorkspaceEntryKind::File => "file",
        WorkspaceEntryKind::Link => "link",
        WorkspaceEntryKind::Other => "other",
    };
    let why = match entry.target {
        Some(WorkspaceLinkTarget::Outside) => "Link to a place outside this folder; not shown",
        Some(WorkspaceLinkTarget::Broken) => "Broken link",
        Some(WorkspaceLinkTarget::Other) => "Link to a special file; not shown",
        _ if entry.kind == WorkspaceEntryKind::Other => "Special file; not shown",
        _ if folder => "Open folder",
        _ => "Preview",
    };
    let size = entry.size.map(files::size_label).unwrap_or_default();
    let when = message_time::short(entry.modified_ms, now_ms.max(entry.modified_ms));
    let full = message_time::full(entry.modified_ms);
    rsx! {
        li { class: "workspace-entry", "data-kind": "{kind}", "data-current": "{current}",
            button { r#type: "button", class: "workspace-entry-open", disabled: !openable, title: "{why}",
                "aria-label": "{entry.name}, {why}",
                onclick: move |_| onopen.call((target.clone(), folder)),
                span { class: "workspace-entry-icon", "aria-hidden": "true",
                    if folder { "▸" } else if entry.kind == WorkspaceEntryKind::Link { "↪" } else { "·" }
                }
                span { class: "workspace-entry-name", "{entry.name}" }
                span { class: "workspace-entry-size", "{size}" }
                span { class: "workspace-entry-time", title: "{full}", "{when}" }
            }
        }
    }
}

#[component]
fn FilePreview(
    conversation: String,
    path: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onclose: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut preview = use_signal(|| None::<WorkspaceFilePreview>);
    let mut failure = use_signal(|| None::<String>);
    let (read_conversation, read_path) = (conversation.clone(), path.clone());
    use_future(move || {
        let (conversation, path) = (read_conversation.clone(), read_path.clone());
        async move {
            let result = crate::transport::request::<WorkspaceFilePreview>(
                "GET",
                &files::preview_url(&conversation, &path),
                Value::Null,
                "",
                "",
            )
            .await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            match result {
                Ok(value) if value.path == path => preview.set(Some(value)),
                Ok(_) => failure.set(Some("The preview could not be verified.".into())),
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => failure.set(Some(error.message)),
            }
        }
    });
    let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
    let download = files::file_url(&conversation, &path, false);
    let inline = files::file_url(&conversation, &path, true);
    let meta = preview.read().as_ref().map(|shown| {
        format!(
            "{} · {}",
            files::size_label(shown.size),
            message_time::full(shown.modified_ms)
        )
    });
    rsx! {
        section { class: "workspace-preview", "aria-label": "Preview of {name}",
            header { class: "workspace-preview-header",
                strong { class: "workspace-preview-name", "{name}" }
                button { r#type: "button", class: "workspace-preview-close", "aria-label": "Close preview", onclick: move |_| onclose.call(()), "Close" }
            }
            if let Some(shown) = preview() {
                if let Some(meta) = meta { p { class: "files-drawer-note", "{meta}" } }
                if shown.downloadable {
                    a { class: "workspace-download", href: "{download}", download: "{name}", "Download" }
                } else {
                    p { class: "files-drawer-note", "Too large to download here (over 25 MB)." }
                }
                match shown.preview {
                    WorkspacePreview::Text { text, truncated } => rsx! {
                        if truncated { p { class: "files-drawer-note", "Showing the first 512 KB." } }
                        pre { class: "workspace-preview-text", tabindex: "0", "{text}" }
                    },
                    WorkspacePreview::Image { .. } => rsx! {
                        img { class: "workspace-preview-image", src: "{inline}", alt: "{name}" }
                    },
                    WorkspacePreview::Binary => rsx! { p { class: "files-empty", "No preview for this kind of file." } },
                    WorkspacePreview::TooLarge => rsx! { p { class: "files-empty", "This image is too large to preview." } },
                }
            } else if let Some(message) = failure() {
                p { class: "files-empty", role: "alert", "{message}" }
            } else {
                p { class: "files-empty", role: "status", "Loading preview…" }
            }
        }
    }
}
