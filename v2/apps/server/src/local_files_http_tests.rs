use super::*;
use crate::conversation_resources_http::tests::{case, send};
use sha2::{Digest, Sha256};

const ORIGIN: &str = "Origin: http://127.0.0.1:19882";

fn csrf(cookie: &str) -> String {
    format!(
        "x-orkestr-csrf: {:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{cookie}").as_bytes())
    )
}

#[tokio::test]
async fn agent_routes_take_only_the_grant_and_a_running_turn() {
    let case = case().await;
    let auth = case.auth();
    let (status, value) = send(
        &case.state,
        "GET",
        &case.path("/local-files-grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!((status, value["issued"].as_bool()), (200, Some(false)));
    let (status, value) = send(
        &case.state,
        "PUT",
        &case.path("/local-files-grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 201);
    let grant = value["grant"].as_str().unwrap().to_owned();
    assert_eq!(grant.len(), 64);
    let header = format!("{LOCAL_FILES_GRANT_HEADER}: {grant}");
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let list = r#"{"request_key":"k-1","operation":"list","path":""}"#;
    let requests = case.path("/local-files/requests");
    // Machine requests only: never beside a cookie, bearer, Origin or a second
    // grant. (A cookie POST is stopped by the browser guard first: 403.)
    let origin = ORIGIN.to_string();
    for (extra, refused) in [(&auth, 401), (&cookie, 403), (&header, 401), (&origin, 401)] {
        let (status, _) = send(&case.state, "POST", &requests, &[&header, extra], list).await;
        assert_eq!(status, refused, "{extra}");
    }
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path(&format!("/local-files/requests/{}", Uuid::new_v4())),
        &[&header, &cookie],
        "",
    )
    .await;
    assert_eq!(status, 401, "a cookie beside the grant");
    // Another capability's grant header, a wrong grant or the owner
    // credential alone never queue a request.
    let wrong = format!("{LOCAL_FILES_GRANT_HEADER}: {}", "0".repeat(64));
    let timer = format!("{AGENT_TIMER_GRANT_HEADER}: {grant}");
    for headers in [
        vec![wrong.as_str()],
        vec![timer.as_str()],
        vec![auth.as_str()],
        vec![],
    ] {
        let (status, _) = send(&case.state, "POST", &requests, &headers, list).await;
        assert_eq!(status, 401);
    }
    let (status, value) = send(&case.state, "POST", &requests, &[&header], list).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("local_files_no_running_turn"))
    );
    // Paths outside the folder, unknown fields (a request never names a
    // conversation) and malformed bodies are refused before the store.
    let foreign = format!(
        r#"{{"request_key":"k","operation":"list","path":"","conversation_id":"{}"}}"#,
        Uuid::new_v4()
    );
    for body in [
        r#"{"request_key":"k","operation":"read","path":"../secret"}"#,
        r#"{"request_key":"k","operation":"read","path":"/etc/passwd"}"#,
        r#"{"request_key":"k","operation":"write","path":"a.txt","content_base64":"!!"}"#,
        r#"{"request_key":"k","operation":"delete","path":"a.txt"}"#,
        foreign.as_str(),
        "not json",
    ] {
        let (status, _) = send(&case.state, "POST", &requests, &[&header], body).await;
        assert_eq!(status, 400, "{body}");
    }
    // A write body above the server-wide 40 KiB body limit still reaches the
    // grant and turn checks (the route allows a 1 MiB write).
    let content = "QUFB".repeat(128 * 1024);
    let write = format!(
        r#"{{"request_key":"w","operation":"write","path":"big.txt","content_base64":"{content}"}}"#
    );
    let (status, value) = send(&case.state, "POST", &requests, &[&header], &write).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("local_files_no_running_turn"))
    );
    let status_path = case.path(&format!("/local-files/requests/{}", Uuid::new_v4()));
    let (status, _) = send(&case.state, "GET", &status_path, &[&header], "").await;
    assert_eq!(status, 404);
    let (status, _) = send(&case.state, "GET", &status_path, &[&auth], "").await;
    assert_eq!(status, 401);
    // Revocation is immediate.
    let (status, value) = send(
        &case.state,
        "DELETE",
        &case.path("/local-files-grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!((status, value["issued"].as_bool()), (200, Some(false)));
    let (status, _) = send(&case.state, "POST", &requests, &[&header], list).await;
    assert_eq!(status, 401);
    let (status, health) = send(&case.state, "GET", "/api/v2/health", &[], "").await;
    assert_eq!(status, 200);
    assert!(health["features"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == "local_files_v1"));
    case.finish().await;
}

#[tokio::test]
async fn tab_routes_need_the_owner_browser_session_and_csrf() {
    let case = case().await;
    let auth = case.auth();
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let csrf = csrf(&case.cookie);
    let tab = Uuid::new_v4();
    let poll = format!(r#"{{"connection_id":"{tab}","folder_name":"Synthetic folder"}}"#);
    let path = case.path("/local-files/poll");
    // A machine bearer is never the folder tab, and a cookie needs CSRF.
    let (status, _) = send(&case.state, "POST", &path, &[&auth], &poll).await;
    assert_eq!(status, 401);
    let (status, _) = send(&case.state, "POST", &path, &[&cookie, ORIGIN], &poll).await;
    assert_eq!(status, 403);
    let (status, value) = send(&case.state, "POST", &path, &[&cookie, ORIGIN, &csrf], &poll).await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["requests"], serde_json::json!([]));
    assert_eq!(value["ttl_ms"].as_i64(), Some(LOCAL_FILE_CONNECTION_TTL_MS));
    // Another tab does not silently replace the connected one.
    let other = format!(
        r#"{{"connection_id":"{}","folder_name":"Other"}}"#,
        Uuid::new_v4()
    );
    let (status, value) = send(
        &case.state,
        "POST",
        &path,
        &[&cookie, ORIGIN, &csrf],
        &other,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("local_files_connected_elsewhere"))
    );
    for bad in [
        r#"{"connection_id":"00000000-0000-0000-0000-000000000000","folder_name":"x"}"#.to_string(),
        format!(r#"{{"connection_id":"{tab}","folder_name":""}}"#),
        format!(r#"{{"connection_id":"{tab}","folder_name":"x","extra":1}}"#),
    ] {
        let (status, _) = send(&case.state, "POST", &path, &[&cookie, ORIGIN, &csrf], &bad).await;
        assert_eq!(status, 400, "{bad}");
    }
    let (status, value) = send(
        &case.state,
        "GET",
        &case.path("/local-files"),
        &[&cookie],
        "",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(value["connection"]["folder_name"], "Synthetic folder");
    assert_eq!(value["connection"]["live"], true);
    let (status, _) = send(&case.state, "GET", &case.path("/local-files"), &[&auth], "").await;
    assert_eq!(
        status, 401,
        "the request log is the tab's, not a machine read"
    );
    // Results: exact request IDs; an unknown request is not found.
    let result = format!(r#"{{"connection_id":"{tab}","outcome":"failed","error":"not_found"}}"#);
    let (status, _) = send(
        &case.state,
        "POST",
        &case.path("/local-files/requests/not-a-uuid/result"),
        &[&cookie, ORIGIN, &csrf],
        &result,
    )
    .await;
    assert_eq!(status, 400);
    let unknown = case.path(&format!("/local-files/requests/{}/result", Uuid::new_v4()));
    let (status, _) = send(
        &case.state,
        "POST",
        &unknown,
        &[&cookie, ORIGIN, &csrf],
        &result,
    )
    .await;
    assert_eq!(status, 404);
    let (status, _) = send(&case.state, "POST", &unknown, &[&auth], &result).await;
    assert_eq!(status, 401);
    // An upload the server has not prepared is never accepted as a result.
    let upload = format!(
        r#"{{"connection_id":"{tab}","outcome":"done","upload_id":"{}"}}"#,
        Uuid::new_v4()
    );
    let (status, value) = send(
        &case.state,
        "POST",
        &unknown,
        &[&cookie, ORIGIN, &csrf],
        &upload,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("local_file_upload_not_ready"))
    );
    let content = case.path(&format!(
        "/local-files/requests/{}/content?connection_id={tab}",
        Uuid::new_v4()
    ));
    let (status, _) = send(&case.state, "GET", &content, &[&auth], "").await;
    assert_eq!(status, 401);
    let disconnect = format!(r#"{{"connection_id":"{tab}"}}"#);
    let (status, _) = send(
        &case.state,
        "POST",
        &case.path("/local-files/disconnect"),
        &[&cookie, ORIGIN, &csrf],
        &disconnect,
    )
    .await;
    assert_eq!(status, 200);
    let (_, value) = send(
        &case.state,
        "GET",
        &case.path("/local-files"),
        &[&cookie],
        "",
    )
    .await;
    assert!(value["connection"].is_null());
    case.finish().await;
}
