//! Registration and bounded request bodies through the real guarded router.
use super::*;
use orkestr_v2_store_sqlite::{
    attachment_store::{keys::ImportedRecipient, seal},
    Store,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn call(
    socket: &std::path::Path,
    token: &str,
    method: &str,
    path: &str,
    body: &[u8],
    digest: Option<&str>,
) -> (u16, Vec<u8>) {
    let mut stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    let content = if digest.is_some() {
        "application/octet-stream"
    } else {
        "application/json"
    };
    let extra = digest
        .map(|v| format!("x-orkestr-ciphertext-sha256: {v}\r\n"))
        .unwrap_or_default();
    let head=format!("{method} {path} HTTP/1.1\r\nHost: localhost:43123\r\nAuthorization: Bearer {token}\r\nContent-Type: {content}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",body.len());
    stream.write_all(head.as_bytes()).await.unwrap();
    // A body rejection can close early; sending the rest is immaterial.
    let _ = stream.write_all(body).await;
    let mut response = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        stream.read_to_end(&mut response),
    )
    .await
    .unwrap()
    .unwrap();
    let split = response.windows(4).position(|v| v == b"\r\n\r\n").unwrap();
    let status = std::str::from_utf8(&response[..split])
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, response[split + 4..].to_vec())
}

#[tokio::test]
async fn encrypted_upload_real_http_registration_limits_replay_and_auth() {
    let home = std::env::temp_dir().join(format!("encrypted-upload-http-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&home).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
    let store = Store::open(&home.join("store.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "ab".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let identity = age::x25519::Identity::generate();
    let recipient = identity.to_public().to_string();
    store
        .import_attachment_recipients(
            &owner,
            &[ImportedRecipient {
                recipient: recipient.clone(),
                label: "Synthetic".into(),
                verified_at: 1,
            }],
        )
        .await
        .unwrap();
    let state = AppState::new(
        store,
        "synthetic-bootstrap-token-long-enough".into(),
        "http://localhost:43123".into(),
    )
    .unwrap()
    .with_attachment_export(crate::message_attachments::ExportDir {
        dir: home.join("exports"),
        gid: None,
    })
    .with_attachment_ingest_home(&home)
    .unwrap();
    let socket = home.join("http.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let server =
        tokio::spawn(async move { axum::serve(listener, crate::router(state)).await.unwrap() });
    let root = format!("/api/v2/conversations/{conversation}/encrypted-uploads");
    let mut file = EncryptedUploadStart {
        upload_id: Uuid::new_v4(),
        filename: "sample.bin".into(),
        media_type: "application/octet-stream".into(),
        plaintext_size: 3,
    };
    let body = serde_json::to_vec(&file).unwrap();
    assert_eq!(
        call(&socket, &"cd".repeat(32), "POST", &root, &body, None)
            .await
            .0,
        401
    );
    let (status, bytes) = call(&socket, &token, "POST", &root, &body, None).await;
    assert_eq!(status, 200);
    let received: EncryptedUploadStatus = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(received.file, file);
    let header=serde_json::json!({"upload_id":file.upload_id,"owner_id":owner,"conversation_id":conversation,"filename":file.filename,"media_type":file.media_type,"plaintext_size":3,"index":0,"chunk_size":3,"plaintext_sha256":seal::sha256_hex(b"abc")}).to_string();
    let payload = format!("ORKESTR-ATTACHMENT-CHUNK/1\n{}\n{header}abc", header.len());
    let ciphertext = seal::encrypt(&received.recipients, payload.as_bytes()).unwrap();
    let digest = seal::sha256_hex(&ciphertext);
    let chunk = format!("{root}/{}/chunks/0", file.upload_id);
    let (status, receipt) = call(&socket, &token, "PUT", &chunk, &ciphertext, Some(&digest)).await;
    assert_eq!(status, 200);
    let receipt: EncryptedUploadChunk = serde_json::from_slice(&receipt).unwrap();
    assert_eq!(
        call(&socket, &token, "PUT", &chunk, &ciphertext, Some(&digest))
            .await
            .0,
        200
    );
    let (status, body) = call(&socket, &token, "GET", &chunk, b"", None).await;
    assert_eq!(status, 200);
    assert_eq!(body, ciphertext);
    let complete = format!("{root}/{}/complete", file.upload_id);
    let (status, body) = call(
        &socket,
        &token,
        "POST",
        &complete,
        &serde_json::to_vec(&vec![receipt]).unwrap(),
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert!(
        serde_json::from_slice::<EncryptedUploadStatus>(&body)
            .unwrap()
            .complete
    );
    let attachment = format!("{root}/{}/attachment", file.upload_id);
    let (status, body) = call(&socket, &token, "POST", &attachment, b"{}", None).await;
    assert_eq!(status, 200);
    let receipt: MessageAttachmentReceipt = serde_json::from_slice(&body).unwrap();
    assert!(receipt.is_valid());
    assert_eq!(receipt.attachments[0].byte_length, 3);
    let folder = home.join("exports").join(conversation.to_string());
    let output = std::fs::read_dir(&folder)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(std::fs::read(output).unwrap(), b"abc");
    assert_eq!(
        call(
            &socket,
            &token,
            "PUT",
            &chunk,
            &vec![0; ENCRYPTED_UPLOAD_CIPHERTEXT_MAX + 1],
            Some(&digest)
        )
        .await
        .0,
        413
    );
    assert_eq!(
        call(
            &socket,
            &token,
            "DELETE",
            &format!("{root}/{}", file.upload_id),
            b"",
            None
        )
        .await
        .0,
        204
    );
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);
    assert_eq!(
        call(
            &socket,
            &token,
            "GET",
            &format!("{root}/{}", file.upload_id),
            b"",
            None
        )
        .await
        .0,
        404
    );
    file.upload_id = Uuid::new_v4();
    file.plaintext_size = ENCRYPTED_UPLOAD_MAX_BYTES + 1;
    assert_eq!(
        call(
            &socket,
            &token,
            "POST",
            &root,
            &serde_json::to_vec(&file).unwrap(),
            None
        )
        .await
        .0,
        400
    );
    server.abort();
    let _ = server.await;
    let _ = std::fs::remove_dir_all(home);
}
