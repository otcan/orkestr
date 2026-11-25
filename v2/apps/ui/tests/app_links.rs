//! The Apps page: the host's links to the owner's tools and apps, and his
//! live published sites. Synthetic hosts only.
use orkestr_v2_ui::app_links::*;
use orkestr_v2_ui::sites;

fn link(id: &str, group: &str) -> Link {
    Link {
        id: id.into(),
        title: format!("Synthetic {id}"),
        url: format!("https://{id}.apps.example.com/"),
        group: group.into(),
        description: None,
        hint: None,
    }
}

#[test]
fn the_answer_reads_as_the_server_writes_it() {
    let page: Page = serde_json::from_value(serde_json::json!({
        "configured": true,
        "links": [{"id": "vault", "title": "Vault (passwords)", "url": "https://vault.example.com/ui/",
            "group": "Tools", "description": "Passwords, tokens and API keys.",
            "hint": "Sign in with OIDC (your Orkestr login)", "future_field": 1},
            {"id": "crm", "title": "CRM", "url": "https://crm.example.org/", "group": "Apps",
            "description": null, "hint": null}]}))
    .unwrap();
    assert!(page.configured && page.error.is_none());
    let vault = &page.links[0];
    assert_eq!(vault.link(), Some("https://vault.example.com/ui/"));
    assert_eq!(vault.address(), "vault.example.com/ui");
    assert_eq!(
        vault.hint.as_deref(),
        Some("Sign in with OIDC (your Orkestr login)")
    );
    assert_eq!(
        (page.links[1].address(), page.links[1].hint.clone()),
        ("crm.example.org", None)
    );
    let empty: Page = serde_json::from_str(r#"{"configured": false, "links": []}"#).unwrap();
    assert_eq!(empty, Page::default());
    let refused: Page =
        serde_json::from_str(r#"{"configured": true, "error": "custody_rejected", "links": []}"#)
            .unwrap();
    assert_eq!(refused.error.as_deref(), Some("custody_rejected"));
}

#[test]
fn links_are_grouped_in_the_hosts_order() {
    let page = Page {
        configured: true,
        error: None,
        links: vec![
            link("vault", "Tools"),
            link("ops", "Dashboards"),
            link("crm", ""),
            link("health", "Dashboards"),
            link("notes", " Tools "),
        ],
    };
    let groups = groups(&page);
    let shape: Vec<(&str, Vec<&str>)> = groups
        .iter()
        .map(|g| {
            (
                g.name.as_str(),
                g.links.iter().map(|l| l.id.as_str()).collect(),
            )
        })
        .collect();
    assert_eq!(
        shape,
        [
            ("Tools", vec!["vault", "notes"]),
            ("Dashboards", vec!["ops", "health"]),
            (DEFAULT_GROUP, vec!["crm"]),
        ],
        "each group where its first link is; no group: the default one"
    );
}

#[test]
fn only_a_plain_https_address_is_linked() {
    for url in [
        "http://plain.example.com/",
        "javascript:alert(1)",
        "https://quote.example.com/\"onload=x",
        "https://space.example.com/a b",
        "https://tick.example.com/`x`",
        "//vault.example.com/",
    ] {
        let unsafe_link = Link {
            url: url.into(),
            ..link("bad", "Tools")
        };
        assert_eq!(unsafe_link.link(), None, "{url}");
        let page = Page {
            links: vec![unsafe_link, link("ok", "Tools")],
            ..Page::default()
        };
        let ids: Vec<String> = groups(&page)
            .into_iter()
            .flat_map(|g| g.links)
            .map(|l| l.id)
            .collect();
        assert_eq!(ids, ["ok"], "{url}");
    }
    let long = Link {
        url: format!("https://long.example.com/{}", "a".repeat(600)),
        ..link("long", "Tools")
    };
    assert_eq!(long.link(), None);
}

#[test]
fn the_page_links_live_published_sites_newest_first() {
    let site = |slug: &str, at: i64, status: &str| sites::Site {
        slug: slug.into(),
        title: String::new(),
        url: format!("https://{slug}.sites.example.com/"),
        kind: "app".into(),
        conversation_id: None,
        published_at_ms: at,
        version: None,
        versions: 0,
        status: status.into(),
    };
    let page = sites::Page {
        configured: true,
        error: None,
        sites: vec![
            site("new", 3, "live"),
            site("off", 2, "disabled"),
            site("old", 1, "live"),
        ],
    };
    let live: Vec<String> = live_sites(&page).into_iter().map(|s| s.slug).collect();
    assert_eq!(live, ["new", "old"], "disabled sites are left out");
    assert_eq!(
        live_sites(&sites::Page::default()),
        Vec::<sites::Site>::new()
    );
}

#[test]
fn refusals_and_answers_read_in_plain_words() {
    for code in [
        "custody_rejected",
        "too_large",
        "too_many_links",
        "invalid_json",
        "unknown_format",
        "unreadable",
        "something_new",
    ] {
        let text = error_text(code);
        assert!(text.starts_with("The server's list of tools and apps was not used: "));
        assert!(!text.contains(code), "{code}: plain words, not the code");
    }
    assert_eq!(
        Links::from_answer(Ok(Page::default())),
        Links::Ready(Page::default())
    );
    assert_eq!(
        Links::from_answer(Err((404, "Endpoint not found".into()))),
        Links::Unsupported,
        "an older server without the route"
    );
    assert_eq!(
        Links::from_answer(Err((401, "Unauthorized".into()))),
        Links::Failed {
            status: 401,
            message: "Unauthorized".into()
        }
    );
    assert_eq!(Links::default(), Links::Loading);
}
