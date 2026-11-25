//! `GET /api/v2/app-links` through the canonical router and guard, with a
//! synthetic links file. Synthetic hosts only.
use super::{catalog::FORMAT, AppLinks};
use crate::conversation_resources_http::tests::{case, send};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;

fn write(path: &std::path::Path, text: &str, mode: u32) {
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn links() -> String {
    json!({"format": FORMAT, "links": [
        {"id": "vault", "title": "Vault (passwords)", "url": "https://vault.example.com/ui/",
         "group": "Tools", "description": "Passwords, tokens and API keys.",
         "hint": "Sign in with OIDC (your Orkestr login)"},
        {"id": "dashboard", "title": "Ops dashboard", "url": "https://dashboard.example.com/"},
        {"id": "loopback", "title": "Not for a browser", "url": "https://127.0.0.1:8200/"}]})
    .to_string()
}

#[tokio::test]
async fn links_are_listed_for_the_owner_password_session_only() {
    let case = case().await;
    let path = case.root.join("app-links.json");
    write(&path, &links(), 0o600);
    let state = case.state.clone().with_links(AppLinks::at(path.clone()));
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
    // owner's cookie: the same refusals as the sites and credentials pages, so
    // no other session learns these addresses.
    let auth = case.auth();
    let service_header = format!("Cookie: orkestr_v2_session={service_cookie}");
    for headers in [
        vec![],
        vec![auth.as_str()],
        vec![service_header.as_str()],
        vec![cookie.as_str(), auth.as_str()],
    ] {
        let (status, value) = send(&state, "GET", "/api/v2/app-links", &headers, "").await;
        assert_eq!(
            (status, value["code"].as_str()),
            (401, Some("unauthorized")),
            "{headers:?}"
        );
        assert!(value.get("links").is_none(), "{headers:?}");
    }
    let (status, value) = send(&state, "GET", "/api/v2/app-links", &[&cookie], "").await;
    assert_eq!(status, 200);
    assert_eq!(
        value,
        json!({"configured": true, "links": [
            {"id": "vault", "title": "Vault (passwords)", "url": "https://vault.example.com/ui/",
             "group": "Tools", "description": "Passwords, tokens and API keys.",
             "hint": "Sign in with OIDC (your Orkestr login)"},
            {"id": "dashboard", "title": "Ops dashboard", "url": "https://dashboard.example.com/",
             "group": "Apps", "description": null, "hint": null}]}),
        "the file's order; an address no browser can open is dropped"
    );
    let (status, health) = send(&state, "GET", "/api/v2/health", &[], "").await;
    assert_eq!(status, 200);
    assert!(health["features"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == "app_links_v1"));
    case.finish().await;
}

#[tokio::test]
async fn a_missing_or_refused_links_file_is_an_empty_list_with_a_fixed_code() {
    let case = case().await;
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let get = |state: crate::AppState| {
        let cookie = cookie.clone();
        async move {
            let (status, value) = send(&state, "GET", "/api/v2/app-links", &[&cookie], "").await;
            assert_eq!(status, 200, "{value}");
            value
        }
    };
    // Not set up at startup (tests, embedders): present but empty.
    let value = get(case.state.clone()).await;
    assert_eq!(value, json!({"configured": false, "links": []}));
    // Set up, but no file yet.
    let path = case.root.join("app-links.json");
    let links_file = AppLinks::at(path.clone());
    let state = case.state.clone().with_links(links_file.clone());
    assert_eq!(
        get(state.clone()).await,
        json!({"configured": false, "links": []})
    );
    // Writable by others: refused before it is parsed, and logged once.
    write(&path, &links(), 0o666);
    let refused = json!({"configured": true, "error": "custody_rejected", "links": []});
    assert_eq!(get(state.clone()).await, refused);
    assert_eq!(links_file.logged(), Some("custody_rejected"));
    assert_eq!(get(state.clone()).await, refused);
    for (text, code) in [
        ("{", "invalid_json"),
        (r#"{"format":"orkestr-app-links-v0"}"#, "unknown_format"),
    ] {
        write(&path, text, 0o600);
        let value: Value = get(state.clone()).await;
        assert_eq!(
            value,
            json!({"configured": true, "error": code, "links": []})
        );
        assert_eq!(links_file.logged(), Some(code));
    }
    // A good file again lists its links and clears the logged refusal; an
    // edit shows on the next read, without a restart.
    write(&path, &links(), 0o600);
    assert_eq!(
        get(state.clone()).await["links"].as_array().unwrap().len(),
        2
    );
    assert_eq!(links_file.logged(), None);
    case.finish().await;
}
