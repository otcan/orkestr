//! The credentials page's wording and choices (ORK-826). Synthetic data only.
use orkestr_v2_contracts::*;
use orkestr_v2_ui::credentials::*;

const A: &str = "00000000-0000-4000-8000-00000000000a";
const B: &str = "00000000-0000-4000-8000-00000000000b";

fn entry(name: &str, conversation: Option<&str>, thread: Option<&str>) -> SidebarEntry {
    SidebarEntry {
        key: conversation.map_or_else(|| format!("v1:{}", thread.unwrap()), |c| format!("v2:{c}")),
        source: if conversation.is_some() {
            SidebarSource::V2
        } else {
            SidebarSource::V1
        },
        name: name.into(),
        conversation_id: conversation.map(|c| ConversationId(c.parse().unwrap())),
        v1_thread_id: thread.map(str::to_owned),
        parent_key: None,
        last_activity_ms: None,
        preview: None,
        unread: 0,
        activity: SidebarActivity::default(),
        read_only: conversation.is_none(),
        coordinator: false,
        read_marker: 0,
        whatsapp: None,
        hidden: false,
    }
}

fn names() -> ChatNames {
    ChatNames::from_sidebar(&[
        entry("Research notes", Some(A), Some("thr_research")),
        entry("Old research (V1)", None, Some("thr_research")),
        entry("Errands", Some(B), None),
        entry("Legacy group", None, Some("thr_legacy")),
    ])
}

fn credential(kind: &str, allowed: &[&str], desks: bool, status: &str) -> Credential {
    Credential {
        id: "synthetic".into(),
        label: "Synthetic portal".into(),
        kind: kind.into(),
        site: "portal.example.com".into(),
        allowed: allowed.iter().map(|s| s.to_string()).collect(),
        owner_desks: desks,
        revision: "3:2026-01-01T00:00:00Z".into(),
        updated_at_ms: None,
        usage: Usage {
            status: status.into(),
            last_used_at_ms: Some(1_000_000),
            last_used_by: Some(A.into()),
            ..Default::default()
        },
    }
}

#[test]
fn chats_are_named_not_shown_as_ids() {
    let names = names();
    let row = credential(
        "password",
        &[A, "00000000-0000-4000-8000-0000000000ff"],
        true,
        "ok",
    );
    assert_eq!(
        used_by(&row, &names),
        ["Research notes", "Chat not in your list", DESKS]
    );
    // A V1 chat imported into V2 is named as the V2 chat; V1-only chats keep theirs.
    assert_eq!(names.label("thr_research"), "Research notes");
    assert_eq!(names.label("thr_legacy"), "Legacy group");
    let conversations: Vec<String> = names
        .choices("conversation")
        .into_iter()
        .map(|c| c.1)
        .collect();
    assert_eq!(conversations, ["Errands", "Research notes"]);
    let threads: Vec<String> = names
        .choices("v1_thread")
        .into_iter()
        .map(|c| c.0)
        .collect();
    assert_eq!(threads, ["thr_legacy", "thr_research"]);
    let (when, by) = last_used(&row, &names, 1_000_000 + 5 * 60_000).unwrap();
    assert_eq!(
        (when.as_str(), by.as_deref()),
        ("5 min ago", Some("Research notes"))
    );
}

#[test]
fn search_covers_name_site_type_and_chats_and_the_filter_narrows_by_type() {
    let names = names();
    let row = credential("api_key", &[B], false, "never_used");
    for query in [
        "",
        "portal",
        "EXAMPLE.com",
        "api key",
        "errands",
        "synthetic errands",
    ] {
        assert!(matches(&row, &names, query, ""), "{query}");
    }
    assert!(!matches(&row, &names, "github", ""));
    assert!(matches(&row, &names, "", "api_key") && !matches(&row, &names, "", "password"));
}

#[test]
fn statuses_say_what_happened() {
    assert_eq!(
        status(&credential("password", &[], true, "ok")),
        ("OK", "good")
    );
    assert_eq!(
        status(&credential("password", &[], true, "failed")),
        ("Failed last sign-in", "bad")
    );
    assert_eq!(
        status(&credential("password", &[], true, "needs_2fa")),
        ("Needs 2FA code", "warn")
    );
    assert_eq!(
        status(&credential("token", &[], false, "never_used")),
        ("Never used", "muted")
    );
    assert_eq!(status_detail("login_failed"), "the site rejected it");
    assert_eq!(status_detail("check:odd_code"), "check odd code");
    assert_eq!(type_label("api_key"), "API key");
    assert_eq!(secret_field("token"), ("token", "Token"));
}

#[test]
fn times_read_naturally() {
    let day = 86_400_000;
    assert_eq!(ago(10_000, 9_000), "just now");
    assert_eq!(ago(3 * 3_600_000, 0), "3 h ago");
    assert_eq!(ago(day + 1, 0), "yesterday");
    assert_eq!(ago(3 * day, 0), "3 days ago");
    assert_eq!(ago(40 * day, 0), "1 Jan");
    assert_eq!(ago(400 * day, 0), "1 Jan 1970");
    assert_eq!(absolute_time(1_794_662_108_640), "14 Nov 2026, 13:15 UTC");
}

#[test]
fn an_edit_sends_only_what_changed_and_the_confirmation_lists_it() {
    let names = names();
    let before = credential("password", &[A], false, "ok");
    let openbao = Capabilities {
        owner_desks_editable: true,
        grant_ids: "conversation".into(),
        ..Default::default()
    };
    assert_eq!(
        metadata_change(
            &before,
            "Synthetic portal",
            "portal.example.com",
            &[A.into()],
            false,
            &openbao
        ),
        None
    );
    let change = metadata_change(
        &before,
        " Portal ",
        "portal.example.com",
        &[B.into()],
        true,
        &openbao,
    )
    .unwrap();
    assert_eq!(change["label"], "Portal");
    assert_eq!(change["allowed"], serde_json::json!([B]));
    assert_eq!(change["owner_desks"], true);
    assert_eq!(change["expected_revision"], before.revision);
    assert!(change.get("site").is_none());
    let summary = change_summary(&before, Some(&change), true, &names);
    assert_eq!(
        summary,
        [
            "Name: “Synthetic portal” → “Portal”",
            "Allow: Errands",
            "Remove: Research notes",
            "Allow: your desks (automatic sign-in)",
            "Replace the stored value"
        ]
    );
    // A store that keeps the site with the value and decides desks itself.
    let vault = Capabilities {
        site_with_value: true,
        ..Default::default()
    };
    assert_eq!(
        metadata_change(
            &before,
            "Synthetic portal",
            "other.example.com",
            &[A.into()],
            true,
            &vault
        ),
        None
    );
}

#[test]
fn the_reveal_link_names_only_a_plain_id() {
    let caps = Capabilities {
        reveal: "external".into(),
        reveal_url: Some(
            "https://bao.example.invalid/ui/vault/secrets/orkestr/kv/creds%2F{id}".into(),
        ),
        ..Default::default()
    };
    assert_eq!(
        reveal_link(&caps, "search").as_deref(),
        Some("https://bao.example.invalid/ui/vault/secrets/orkestr/kv/creds%2Fsearch")
    );
    assert_eq!(reveal_link(&caps, "../x"), None);
    assert_eq!(reveal_link(&Capabilities::default(), "search"), None);
}

#[test]
fn the_page_answer_parses_as_the_server_sends_it() {
    let page: Page = serde_json::from_value(serde_json::json!({"schema_version": 1, "backend": "openbao",
        "capabilities": {"types": ["password", "token", "api_key"], "grant_ids": "conversation", "owner_desks_editable": true,
            "site_with_value": false, "value_replace": "fields", "reveal": "external", "reveal_url": null, "vault_import": false},
        "credentials": [{"id": "search", "label": "Search", "type": "api_key", "site": "search.example.com", "allowed": [A], "owner_desks": false,
            "revision": "2:x", "updated_at_ms": null, "fields": [],
            "usage": {"last_used_at_ms": 5, "last_used_by": A, "chats": [{"id": A, "last_at_ms": 5, "uses": 2}], "status": "ok", "status_at_ms": null, "status_detail": null}}],
        "truncated": false, "catalog_at_ms": null, "usage": {"observed_at_ms": 5, "stale": false}}))
    .unwrap();
    assert_eq!(
        (
            page.credentials[0].usage.chats[0].uses,
            page.capabilities.value_replace.as_str()
        ),
        (2, "fields")
    );
}
