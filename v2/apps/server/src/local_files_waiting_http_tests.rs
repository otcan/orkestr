use super::*;
use crate::conversation_resources_http::tests::send;
use crate::timer_capabilities_http::tests::fixture;
use sha2::{Digest, Sha256};

const ORIGIN: &str = "Origin: http://127.0.0.1:19882";
const PATH: &str = "/api/v2/local-files/waiting";

fn csrf(cookie: &str) -> String {
    format!(
        "x-orkestr-csrf: {:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{cookie}").as_bytes())
    )
}

#[tokio::test]
async fn every_owner_session_sees_which_conversation_waits_for_a_write() {
    let case = fixture::running(false).await;
    let auth = case.auth();
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let csrf = csrf(&case.cookie);
    let (status, _) = send(&case.state, "GET", PATH, &[], "").await;
    assert_eq!(status, 401);
    let (status, value) = send(&case.state, "GET", PATH, &[&cookie], "").await;
    assert_eq!(
        (status, value),
        (200, serde_json::json!({"conversations": []}))
    );
    // A granted conversation with a running turn and a connected tab.
    let (_, issued) = send(
        &case.state,
        "PUT",
        &case.path("/local-files-grant"),
        &[&auth],
        "",
    )
    .await;
    let grant = format!(
        "{LOCAL_FILES_GRANT_HEADER}: {}",
        issued["grant"].as_str().unwrap()
    );
    let tab = Uuid::new_v4();
    let poll = format!(r#"{{"connection_id":"{tab}","folder_name":"Synthetic folder"}}"#);
    let poll_path = case.path("/local-files/poll");
    let tab_headers = [cookie.as_str(), ORIGIN, csrf.as_str()];
    let (status, _) = send(&case.state, "POST", &poll_path, &tab_headers, &poll).await;
    assert_eq!(status, 200);
    let write =
        r#"{"request_key":"w-1","operation":"write","path":"notes.txt","content_base64":"aGk="}"#;
    let (status, queued) = send(
        &case.state,
        "POST",
        &case.path("/local-files/requests"),
        &[&grant],
        write,
    )
    .await;
    assert_eq!(status, 202, "{queued}");
    // The browser of another tab or device, and the owner's machine read.
    for headers in [vec![cookie.as_str()], vec![auth.as_str()]] {
        let (status, value) = send(&case.state, "GET", PATH, &headers, "").await;
        assert_eq!(status, 200, "{value}");
        let listed = value["conversations"].as_array().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["conversation_id"], case.conversation.to_string());
        assert_eq!(listed[0]["folder_name"], "Synthetic folder");
        assert_eq!(listed[0]["writes"], 1);
        assert_eq!(listed[0]["deadline_ms"], queued["request"]["deadline_ms"]);
        assert!(listed[0]["conversation_name"]
            .as_str()
            .is_some_and(|n| !n.is_empty()));
    }
    // The owner refuses it in the folder tab: nothing waits any more.
    let (_, held) = send(&case.state, "POST", &poll_path, &tab_headers, &poll).await;
    let request = held["requests"][0]["request_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, _) = send(
        &case.state,
        "POST",
        &case.path(&format!("/local-files/requests/{request}/result")),
        &tab_headers,
        &format!(r#"{{"connection_id":"{tab}","outcome":"failed","error":"refused_by_owner"}}"#),
    )
    .await;
    assert_eq!(status, 200);
    let (_, value) = send(&case.state, "GET", PATH, &[&cookie], "").await;
    assert_eq!(value["conversations"], serde_json::json!([]));
    let (_, health) = send(&case.state, "GET", "/api/v2/health", &[], "").await;
    assert!(health["features"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == LOCAL_FILE_WRITES_WAITING_FEATURE));
    case.finish().await;
}
