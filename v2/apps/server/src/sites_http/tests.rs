//! `GET /api/v2/sites` through the canonical router and guard, with a
//! synthetic catalog file. Synthetic hosts and ids only.
use super::{catalog::FORMAT, SitesCatalog};
use crate::conversation_resources_http::tests::{case, send};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;

const CHAT: &str = "00000000-0000-4000-8000-000000000001";

fn write(path: &std::path::Path, text: &str, mode: u32) {
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn catalog() -> String {
    json!({"format": FORMAT, "generated_at_ms": 1_763_208_000_000_i64, "sites": [
        {"slug": "crm", "title": "CRM", "url": "https://crm.sites.example.com/", "kind": "app",
         "conversation_id": null, "published_at_ms": 1_763_100_000_000_i64, "version": null,
         "versions": 0, "status": "live"},
        {"slug": "notes", "title": "Team notes", "url": "https://notes.sites.example.com/",
         "kind": "static", "conversation_id": CHAT, "published_at_ms": 1_763_207_000_000_i64,
         "version": "v0003", "versions": 3, "status": "live"},
        {"slug": "old", "title": "", "url": "https://old.sites.example.com/", "kind": "static",
         "conversation_id": CHAT, "published_at_ms": 1_000, "version": "v0001", "versions": 1,
         "status": "disabled"},
        {"slug": "Bad", "url": "https://bad.sites.example.com/", "kind": "static",
         "published_at_ms": 1, "status": "live"}]})
    .to_string()
}

#[tokio::test]
async fn sites_are_listed_for_the_owner_password_session_only() {
    let case = case().await;
    let path = case.root.join("sites-catalog.json");
    write(&path, &catalog(), 0o600);
    let state = case
        .state
        .clone()
        .with_sites(SitesCatalog::at(path.clone()));
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let service = "6".repeat(64);
    let service_cookie = "7".repeat(64);
    state
        .store
        .create_service_credential(
            &format!("browser:{}", case.cookie),
            "synthetic-hash",
            "adapter",
            &service,
        )
        .await
        .unwrap()
        .unwrap();
    state
        .store
        .exchange_service_session(&service, &format!("browser:{service_cookie}"))
        .await
        .unwrap()
        .unwrap();
    // No session, a machine bearer, a service session, or a bearer beside the
    // owner's cookie: the same refusals as the credentials page.
    let auth = case.auth();
    let service_header = format!("Cookie: orkestr_v2_session={service_cookie}");
    for headers in [
        vec![],
        vec![auth.as_str()],
        vec![service_header.as_str()],
        vec![cookie.as_str(), auth.as_str()],
    ] {
        let (status, value) = send(&state, "GET", "/api/v2/sites", &headers, "").await;
        assert_eq!(
            (status, value["code"].as_str()),
            (401, Some("unauthorized")),
            "{headers:?}"
        );
    }
    let (status, value) = send(&state, "GET", "/api/v2/sites", &[&cookie], "").await;
    assert_eq!(status, 200);
    let slugs: Vec<&str> = value["sites"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["slug"].as_str().unwrap())
        .collect();
    assert_eq!(slugs, ["notes", "crm", "old"], "newest publish first");
    assert_eq!(value["configured"], true);
    assert!(
        value.get("error").is_none(),
        "no error key when the file is used"
    );
    assert_eq!(
        value["sites"][0],
        json!({"slug": "notes", "title": "Team notes", "url": "https://notes.sites.example.com/",
            "kind": "static", "conversation_id": CHAT, "published_at_ms": 1_763_207_000_000_i64,
            "version": "v0003", "versions": 3, "status": "live"})
    );
    assert_eq!(value["sites"][2]["status"], "disabled");
    let (status, health) = send(&state, "GET", "/api/v2/health", &[], "").await;
    assert_eq!(status, 200);
    assert!(health["features"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == "sites_v1"));
    case.finish().await;
}

#[tokio::test]
async fn a_missing_or_refused_catalog_is_an_empty_list_with_a_fixed_code() {
    let case = case().await;
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let get = |state: crate::AppState| {
        let cookie = cookie.clone();
        async move {
            let (status, value) = send(&state, "GET", "/api/v2/sites", &[&cookie], "").await;
            assert_eq!(status, 200, "{value}");
            value
        }
    };
    // Not set up at startup (tests, embedders): present but empty.
    let value = get(case.state.clone()).await;
    assert_eq!(value, json!({"configured": false, "sites": []}));
    // Set up, but nothing published yet.
    let path = case.root.join("sites-catalog.json");
    let sites = SitesCatalog::at(path.clone());
    let state = case.state.clone().with_sites(sites.clone());
    assert_eq!(
        get(state.clone()).await,
        json!({"configured": false, "sites": []})
    );
    // Writable by others: refused before it is parsed, and logged once.
    write(&path, &catalog(), 0o666);
    let refused = json!({"configured": true, "error": "custody_rejected", "sites": []});
    assert_eq!(get(state.clone()).await, refused);
    assert_eq!(sites.logged(), Some("custody_rejected"));
    assert_eq!(get(state.clone()).await, refused);
    for (text, code) in [
        ("{", "invalid_json"),
        (
            r#"{"format":"orkestr-sites-catalog-v0","generated_at_ms":0}"#,
            "unknown_format",
        ),
    ] {
        write(&path, text, 0o600);
        let value: Value = get(state.clone()).await;
        assert_eq!(
            value,
            json!({"configured": true, "error": code, "sites": []})
        );
        assert_eq!(sites.logged(), Some(code));
    }
    // A good file again lists its sites and clears the logged refusal.
    write(&path, &catalog(), 0o600);
    assert_eq!(
        get(state.clone()).await["sites"].as_array().unwrap().len(),
        3
    );
    assert_eq!(sites.logged(), None);
    case.finish().await;
}
