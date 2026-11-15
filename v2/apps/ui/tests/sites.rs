//! The Sites page and the chat header's Site link (ORK-834). Synthetic hosts
//! and ids only.
use orkestr_v2_contracts::*;
use orkestr_v2_ui::credentials::ChatNames;
use orkestr_v2_ui::sites::*;

const A: &str = "00000000-0000-4000-8000-00000000000a";
const B: &str = "00000000-0000-4000-8000-00000000000b";

fn site(slug: &str, chat: Option<&str>, at: i64, status: &str) -> Site {
    Site {
        slug: slug.into(),
        title: format!("Synthetic {slug}"),
        url: format!("https://{slug}.sites.example.com/"),
        kind: "static".into(),
        conversation_id: chat.map(str::to_owned),
        published_at_ms: at,
        version: Some("v0002".into()),
        versions: 2,
        status: status.into(),
    }
}

fn names() -> ChatNames {
    let entry = |name: &str, id: &str| SidebarEntry {
        key: format!("v2:{id}"),
        source: SidebarSource::V2,
        name: name.into(),
        conversation_id: Some(ConversationId(id.parse().unwrap())),
        v1_thread_id: None,
        parent_key: None,
        last_activity_ms: None,
        preview: None,
        unread: 0,
        activity: SidebarActivity::default(),
        read_only: false,
        coordinator: false,
        read_marker: 0,
        whatsapp: None,
        hidden: false,
    };
    ChatNames::from_sidebar(&[entry("Research notes", A)])
}

#[test]
fn the_answer_reads_as_the_server_writes_it() {
    let page: Page = serde_json::from_value(serde_json::json!({
        "configured": true,
        "sites": [{"slug": "notes", "title": "", "url": "https://notes.sites.example.com/", "kind": "app",
            "conversation_id": null, "published_at_ms": 5, "version": null, "versions": 0, "status": "live",
            "future_field": 1}]}))
    .unwrap();
    assert!(page.configured && page.error.is_none());
    let notes = &page.sites[0];
    assert_eq!((notes.name(), kind_label(&notes.kind)), ("notes", "App"));
    assert_eq!(notes.address(), "notes.sites.example.com");
    assert_eq!(version_label(notes), "—");
    assert_eq!(chat_label(notes, &names()), "No chat");
    let empty: Page = serde_json::from_str(r#"{"configured": false, "sites": []}"#).unwrap();
    assert_eq!(empty, Page::default());
    let refused: Page =
        serde_json::from_str(r#"{"configured": true, "error": "custody_rejected", "sites": []}"#)
            .unwrap();
    assert!(error_text(refused.error.as_deref().unwrap()).contains("not protected"));
}

#[test]
fn rows_name_their_chat_kind_and_version() {
    let names = names();
    let row = site("notes", Some(A), 1, "live");
    assert_eq!(chat_label(&row, &names), "Research notes");
    assert_eq!(
        chat_label(&site("x", Some(B), 1, "live"), &names),
        "Chat not in your list"
    );
    assert_eq!(kind_label("static"), "Static site");
    assert_eq!(kind_label("other"), "Site");
    assert_eq!(version_label(&row), "v0002 · 2 versions");
    let first = Site {
        versions: 1,
        version: Some("v0001".into()),
        ..row.clone()
    };
    assert_eq!(version_label(&first), "v0001");
    assert_eq!(row.name(), "Synthetic notes");
    assert_eq!(row.link(), Some("https://notes.sites.example.com/"));
}

#[test]
fn disabled_or_odd_addresses_never_get_an_open_link() {
    assert_eq!(site("old", Some(A), 1, "disabled").link(), None);
    for url in [
        "http://plain.sites.example.com/",
        "javascript:alert(1)",
        "https://quote.sites.example.com/\"x",
        "https://space.sites.example.com/a b",
    ] {
        let odd = Site {
            url: url.into(),
            ..site("odd", Some(A), 1, "live")
        };
        assert_eq!(odd.link(), None, "{url}");
    }
}

#[test]
fn the_header_links_the_chats_newest_live_site_and_counts_the_rest() {
    let page = Page {
        configured: true,
        error: None,
        sites: vec![
            site("older", Some(A), 10, "live"),
            site("newest-off", Some(A), 30, "disabled"),
            site("newest", Some(A), 20, "live"),
            site("other-chat", Some(B), 40, "live"),
            site("no-chat", None, 50, "live"),
        ],
    };
    let link = header_link(&page, A).unwrap();
    assert_eq!(
        link,
        HeaderLink {
            url: "https://newest.sites.example.com/".into(),
            name: "Synthetic newest".into(),
            others: 2,
        }
    );
    assert_eq!(
        header_link(&page, &A.to_uppercase()).map(|l| l.url),
        Some(link.url.clone()),
        "ids compare without case"
    );
    let single = header_link(&page, B).unwrap();
    assert_eq!(
        (single.name.as_str(), single.others),
        ("Synthetic other-chat", 0)
    );
    assert_eq!(
        header_link(&page, "00000000-0000-4000-8000-00000000000c"),
        None
    );
    assert_eq!(header_link(&page, ""), None);
    let only_disabled = Page {
        sites: vec![site("off", Some(A), 1, "disabled")],
        ..page.clone()
    };
    assert_eq!(
        header_link(&only_disabled, A),
        None,
        "no live site, no link"
    );
}

#[test]
fn an_older_server_or_a_failed_read_shows_no_header_link() {
    let page = Page {
        configured: true,
        error: None,
        sites: vec![site("notes", Some(A), 1, "live")],
    };
    assert!(Catalog::from_answer(Ok(page.clone()))
        .header_link(A)
        .is_some());
    let missing = Catalog::from_answer(Err((404, "Endpoint not found".into())));
    assert_eq!(missing, Catalog::Unsupported);
    let refused = Catalog::from_answer(Err((401, "Authentication required".into())));
    let busy = Catalog::from_answer(Err((503, "Busy".into())));
    for catalog in [
        Catalog::Loading,
        missing.clone(),
        refused.clone(),
        busy.clone(),
    ] {
        assert_eq!(catalog.header_link(A), None, "{catalog:?}");
    }
    // A server without the route, or a session it refuses, is not polled again.
    assert!(!missing.polls() && !refused.polls());
    assert!(busy.polls() && Catalog::Loading.polls() && Catalog::Ready(page).polls());
}
