use orkestr_v2_contracts::{ConversationId, WorkspaceListing, WorkspaceRootKind, WorkspaceState};
use orkestr_v2_ui::workspace_files::*;

const CHAT: &str = "00000000-0000-4000-8000-000000000001";

fn listing(kind: Option<WorkspaceRootKind>) -> WorkspaceListing {
    WorkspaceListing {
        conversation_id: ConversationId(CHAT.parse().unwrap()),
        state: WorkspaceState::Ready,
        root_kind: kind,
        root_name: Some("orkestr-oss".into()),
        path: String::new(),
        entries: Vec::new(),
        hidden: 0,
        truncated: false,
    }
}

#[test]
fn paths_and_breadcrumbs() {
    assert_eq!(child("", "docs"), "docs");
    assert_eq!(child("docs", "plan.md"), "docs/plan.md");
    assert_eq!(parent("docs/notes/a.md"), "docs/notes");
    assert_eq!(parent("docs"), "");
    assert_eq!(
        crumbs("workspace", "docs/notes"),
        vec![
            ("workspace".to_owned(), String::new()),
            ("docs".to_owned(), "docs".to_owned()),
            ("notes".to_owned(), "docs/notes".to_owned()),
        ]
    );
    assert_eq!(
        crumbs("workspace", ""),
        vec![("workspace".to_owned(), String::new())]
    );
}

#[test]
fn urls_encode_the_path() {
    assert_eq!(
        list_url(CHAT, "my docs/ä&b"),
        format!("/api/v2/conversations/{CHAT}/workspace?path=my%20docs%2F%C3%A4%26b")
    );
    assert_eq!(
        preview_url(CHAT, "a.md"),
        format!("/api/v2/conversations/{CHAT}/workspace/preview?path=a.md")
    );
    assert_eq!(
        file_url(CHAT, "img/c.png", true),
        format!("/api/v2/conversations/{CHAT}/workspace/file?path=img%2Fc.png&inline=true")
    );
    assert_eq!(
        file_url(CHAT, "c.png", false),
        format!("/api/v2/conversations/{CHAT}/workspace/file?path=c.png")
    );
}

#[test]
fn sizes_read_like_a_file_manager() {
    assert_eq!(size_label(0), "0 B");
    assert_eq!(size_label(1023), "1023 B");
    assert_eq!(size_label(4096), "4.0 KB");
    assert_eq!(size_label(1_258_291), "1.2 MB");
    assert_eq!(size_label(3 * 1024 * 1024 * 1024), "3.0 GB");
}

#[test]
fn the_shared_default_folder_is_never_presented_as_the_chats_own() {
    let (title, note) = root_heading(&listing(Some(WorkspaceRootKind::SharedDefault)));
    assert_eq!(title, "Shared default workspace");
    assert!(note.unwrap().contains("Not this chat's own folder"));
    let (title, note) = root_heading(&listing(Some(WorkspaceRootKind::Conversation)));
    assert_eq!(
        (title.as_str(), note),
        ("This chat's folder · orkestr-oss", None)
    );
}

#[test]
fn states_and_hidden_items_are_said_in_words() {
    assert_eq!(state_text(WorkspaceState::Ready), None);
    assert!(state_text(WorkspaceState::NotConfigured)
        .unwrap()
        .contains("cannot show the chat's folder"));
    assert!(state_text(WorkspaceState::Missing)
        .unwrap()
        .contains("does not exist"));
    assert_eq!(hidden_note(0), None);
    assert_eq!(
        hidden_note(1).as_deref(),
        Some("1 protected item hidden (keys, tokens, credentials).")
    );
    assert_eq!(
        hidden_note(3).as_deref(),
        Some("3 protected items hidden (keys, tokens, credentials).")
    );
}
