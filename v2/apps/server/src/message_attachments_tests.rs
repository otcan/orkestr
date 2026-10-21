use super::*;
use crate::conversation_resources_http::tests::{case, send};
use crate::sidebar_http::tests::{fake_v1_with_inputs, V1_TOKEN};
use std::sync::{Arc as StdArc, Mutex as StdMutex};

/// A real 1x1 PNG (synthetic pixel).
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
    1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0d, 0x49, 0x44, 0x41, 0x54,
    0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0, 5, 0, 1, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0, 0,
    0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

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

#[test]
fn base64_round_trips_and_refuses_garbage() {
    for sample in [
        &b""[..],
        b"f",
        b"fo",
        b"foo",
        b"foob",
        b"fooba",
        b"foobar",
        PNG,
    ] {
        assert_eq!(decode_base64(&b64(sample)).unwrap(), sample);
    }
    assert_eq!(decode_base64("Zm9v\nYmFy").unwrap(), b"foobar");
    assert!(decode_base64("Zm9v!").is_none());
    assert!(decode_base64("Z").is_none());
    assert!(decode_base64("Zg===").is_none());
}

#[tokio::test]
async fn attached_image_is_stored_written_for_the_model_and_named_in_the_note() {
    let mut case = case().await;
    let dir = case.root.join("exports");
    case.state = case.state.clone().with_attachment_export(ExportDir {
        dir: dir.clone(),
        gid: None,
    });
    let auth = case.auth();
    let key = "6a3f5c47-3c2d-4bd6-9d33-0c1a1e7f1b2a";
    let body = upload(
        key,
        &[
            ("photo.png", "image/png", PNG),
            ("pasted text.txt", "text/plain", b"long pasted text"),
        ],
    );
    let path = case.path("/message-attachments");
    let (status, receipt) = send(&case.state, "POST", &path, &[&auth], &body).await;
    assert_eq!(status, 200, "{receipt}");
    let receipt: MessageAttachmentReceipt = serde_json::from_value(receipt).unwrap();
    assert!(receipt.is_valid());
    assert_eq!(receipt.attachments.len(), 2);
    let sha = format!("{:x}", Sha256::digest(PNG));
    let image = dir
        .join(case.conversation.to_string())
        .join(format!("{sha}.png"));
    assert_eq!(
        std::fs::read(&image).unwrap(),
        PNG,
        "the model opens these exact bytes"
    );
    assert!(receipt
        .note
        .contains(&format!("photo.png (image/png, {} bytes", PNG.len())));
    assert!(receipt
        .note
        .contains(&format!("local file {}", image.display())));
    assert!(receipt.note.contains("image viewing tool"));
    // A replay stores nothing new and names the same files.
    let (status, again) = send(&case.state, "POST", &path, &[&auth], &body).await;
    assert_eq!(status, 200);
    let again: MessageAttachmentReceipt = serde_json::from_value(again).unwrap();
    assert_eq!(again, receipt);
    let (_, page) = send(
        &case.state,
        "GET",
        &case.path("/attachment-manifests?limit=16"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(page["manifests"].as_array().unwrap().len(), 1);
    assert_eq!(page["manifests"][0]["references"][0]["sha256"], sha);
    // Different files under the same key are refused; bad input is refused.
    let (status, _) = send(
        &case.state,
        "POST",
        &path,
        &[&auth],
        &upload(key, &[("other.png", "image/png", b"x")]),
    )
    .await;
    assert_eq!(status, 409);
    let (status, _) = send(
        &case.state,
        "POST",
        &path,
        &[&auth],
        &upload(key, &[("../x.png", "image/png", b"x")]),
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = send(&case.state, "POST", &path, &[], &body).await;
    assert_eq!(status, 401);
    case.finish().await;
}

#[tokio::test]
async fn linked_v1_chat_uploads_to_v1_and_the_input_carries_the_files() {
    let mut case = case().await;
    let calls = StdArc::new(StdMutex::new(Vec::new()));
    let inputs = StdArc::new(StdMutex::new(Vec::new()));
    let url = fake_v1_with_inputs(calls, inputs.clone()).await;
    case.state.desktop_broker = Some(Arc::new(
        crate::desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
    ));
    let auth = case.auth();
    let key = "0b0e4b5e-7d3f-4c55-8d0f-3f2a9b7c1d10";
    let (status, receipt) = send(
        &case.state,
        "POST",
        "/api/v2/v1-threads/group-coordinated/uploads",
        &[&auth],
        &upload(key, &[("photo.png", "image/png", PNG)]),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let receipt: MessageAttachmentReceipt = serde_json::from_value(receipt).unwrap();
    assert!(receipt.is_valid() && receipt.manifest_id.is_none());
    let id = receipt.attachments[0].attachment_id.clone();
    let input = json!({"client_message_id": "1a2b3c4d-0000-4000-8000-000000000001", "text": "Synthetic look at this", "attachment_ids": [id]});
    let (status, _) = send(
        &case.state,
        "POST",
        "/api/v2/v1-threads/group-coordinated/messages",
        &[&auth],
        &input.to_string(),
    )
    .await;
    assert_eq!(status, 202);
    let sent = inputs.lock().unwrap()[0].1.clone();
    assert_eq!(
        sent["attachments"][0]["path"],
        "/synthetic-v1/uploads/group-coordinated/photo.png"
    );
    assert_eq!(sent["attachments"][0]["mimetype"], "image/png");
    // Uploads belong to their thread; unknown ids are refused before V1.
    let other = json!({"client_message_id": "1a2b3c4d-0000-4000-8000-000000000002", "text": "Synthetic",
        "attachment_ids": ["1a2b3c4d-0000-4000-8000-0000000000ff"]});
    let (status, value) = send(
        &case.state,
        "POST",
        "/api/v2/v1-threads/group-coordinated/messages",
        &[&auth],
        &other.to_string(),
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("v1_upload_expired"))
    );
    let (status, _) = send(
        &case.state,
        "POST",
        "/api/v2/v1-threads/unbound/uploads",
        &[&auth],
        &upload(key, &[("photo.png", "image/png", PNG)]),
    )
    .await;
    assert_eq!(status, 404);
    case.finish().await;
}
