use super::*;
use crate::conversation_resources_http::tests::{case, send};
use crate::message_attachments::ExportDir;
use crate::timer_capabilities_http::tests::fixture;
use serde_json::json;

const ZIP: &[u8] = b"PK\x03\x04synthetic package\0\x01\x02";

fn b64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |a, (i, b)| a | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
fn upload(key: &str, files: &[(&str, &str, &[u8])]) -> String {
    json!({"request_key": key, "files": files.iter().map(|(n, t, b)| json!({
        "filename": n, "media_type": t, "content_base64": b64(b)})).collect::<Vec<_>>()})
    .to_string()
}

#[tokio::test]
async fn a_running_deep_turn_attaches_a_workspace_file_to_its_reply() {
    let mut case = fixture::running(false).await;
    let dir = case.root.join("exports");
    case.state = case.state.clone().with_attachment_export(ExportDir {
        dir: dir.clone(),
        gid: None,
    });
    let auth = case.auth();
    let (_, issued) = send(
        &case.state,
        "PUT",
        &case.path("/agent-timer-grant"),
        &[&auth],
        "",
    )
    .await;
    let header = format!(
        "{AGENT_TIMER_GRANT_HEADER}: {}",
        issued["grant"].as_str().unwrap()
    );
    let path = case.path("/agent-attachments");
    let key = "00000000-0000-4000-8000-000000000a01";
    let body = upload(key, &[("October package.zip", "application/zip", ZIP)]);
    // Machine requests with the agent grant only: never the owner's
    // credential, a cookie beside the grant, or no grant at all.
    // (A cookie request is refused by the browser guard first: 403.)
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    for (headers, expected) in [
        (vec![auth.as_str()], 401),
        (vec![header.as_str(), auth.as_str()], 401),
        (vec![header.as_str(), cookie.as_str()], 403),
        (vec![], 401),
    ] {
        let (status, _) = send(&case.state, "POST", &path, &headers, &body).await;
        assert_eq!(status, expected, "{headers:?}");
    }
    let (_, page) = send(
        &case.state,
        "GET",
        &case.path("/attachment-manifests?limit=16"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(page["manifests"].as_array().map(Vec::len), Some(0));
    let (status, value) = send(&case.state, "POST", &path, &[&header], &body).await;
    assert_eq!(status, 201, "{value}");
    let receipt: MessageAttachmentReceipt = serde_json::from_value(value).unwrap();
    assert!(receipt.is_valid());
    let manifest = receipt.manifest_id.unwrap();
    let reference = receipt.attachments[0].attachment_id.clone();
    // One marker line for the reply: opaque scoped IDs, never a path.
    assert_eq!(
        receipt.note,
        format!("[orkestr-attachment manifest={manifest} reference={reference} name=\"October package.zip\"]")
    );
    assert_eq!(
        agent_attachment_refs(&receipt.note),
        vec![(manifest, Uuid::parse_str(&reference).unwrap())]
    );
    assert!(!receipt.note.contains(&dir.display().to_string()));
    // The delivery copy the WhatsApp adapter sends from.
    let sha = format!("{:x}", Sha256::digest(ZIP));
    let copy = dir
        .join(case.conversation.to_string())
        .join(format!("{sha}.zip"));
    assert_eq!(std::fs::read(&copy).unwrap(), ZIP);
    // A retry stores nothing new and answers the same markers.
    let (status, again) = send(&case.state, "POST", &path, &[&header], &body).await;
    assert_eq!(status, 200);
    let again: MessageAttachmentReceipt = serde_json::from_value(again).unwrap();
    assert_eq!(again, receipt);
    // The same key for other bytes never becomes a second file.
    let changed = upload(key, &[("October package.zip", "application/zip", b"other")]);
    let (status, value) = send(&case.state, "POST", &path, &[&header], &changed).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("agent_attachment_conflict"))
    );
    // Only types the WhatsApp worker sends, with a matching extension.
    for (name, media) in [
        ("page.html", "text/html"),
        ("report.pdf", "application/zip"),
        ("tool.exe", "application/octet-stream"),
    ] {
        let other = upload(
            "00000000-0000-4000-8000-000000000a02",
            &[(name, media, b"x")],
        );
        let (status, value) = send(&case.state, "POST", &path, &[&header], &other).await;
        assert_eq!(
            (status, value["code"].as_str()),
            (415, Some("agent_attachment_type_refused")),
            "{name}"
        );
    }
    // The owner (the adapter) reads it as this conversation's agent attachment.
    let record = case.path(&format!("/agent-attachments/{manifest}"));
    let (status, value) = send(&case.state, "GET", &record, &[&auth], "").await;
    assert_eq!(status, 200, "{value}");
    let read: AttachmentManifest = serde_json::from_value(value).unwrap();
    assert_eq!(read.conversation_id, case.conversation);
    assert_eq!(read.references[0].sha256, sha);
    assert_eq!(read.references[0].media_type, "application/zip");
    let (status, _) = send(&case.state, "GET", &record, &[&header], "").await;
    assert_eq!(status, 401);
    // An owner upload is not an agent attachment, so it is never sent.
    let owner_upload = json!({"request_key": "00000000-0000-4000-8000-000000000a03",
        "files": [{"filename": "private.pdf", "media_type": "application/pdf", "content_base64": b64(b"%PDF")}]});
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/message-attachments"),
        &[&auth],
        &owner_upload.to_string(),
    )
    .await;
    assert_eq!(status, 200, "{value}");
    let owned = value["manifest_id"].as_str().unwrap();
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path(&format!("/agent-attachments/{owned}")),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 404);
    case.finish().await;
}

#[tokio::test]
async fn without_a_running_deep_turn_nothing_is_attached() {
    let case = case().await;
    let auth = case.auth();
    let (_, issued) = send(
        &case.state,
        "PUT",
        &case.path("/agent-timer-grant"),
        &[&auth],
        "",
    )
    .await;
    let header = format!(
        "{AGENT_TIMER_GRANT_HEADER}: {}",
        issued["grant"].as_str().unwrap()
    );
    let body = upload(
        "00000000-0000-4000-8000-000000000a01",
        &[("notes.md", "text/markdown", b"# Notes")],
    );
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/agent-attachments"),
        &[&header],
        &body,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("agent_attachment_no_running_turn"))
    );
    let (_, page) = send(
        &case.state,
        "GET",
        &case.path("/attachment-manifests?limit=16"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(page["manifests"].as_array().map(Vec::len), Some(0));
    case.finish().await;
}
