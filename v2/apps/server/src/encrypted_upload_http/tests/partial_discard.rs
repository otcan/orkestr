//! ORK-790: the composer's Cancel discards a partial upload through the
//! existing DELETE route. Real guarded router, synthetic owner and bytes.
use super::*;

#[tokio::test]
async fn cancelled_partial_upload_is_discarded_and_cannot_be_resumed_or_attached() {
    let home = std::env::temp_dir().join(format!("encrypted-upload-discard-{}", Uuid::new_v4()));
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
    let token = "ef".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    store
        .import_attachment_recipients(
            &owner,
            &[ImportedRecipient {
                recipient: age::x25519::Identity::generate().to_public().to_string(),
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
    // Two chunks; the owner cancels after the first one is stored.
    let file = EncryptedUploadStart {
        upload_id: Uuid::new_v4(),
        filename: "partial.bin".into(),
        media_type: "application/octet-stream".into(),
        plaintext_size: ENCRYPTED_UPLOAD_CHUNK_BYTES + 3,
    };
    let start = serde_json::to_vec(&file).unwrap();
    let (status, body) = call(&socket, &token, "POST", &root, &start, None).await;
    assert_eq!(status, 200);
    let started: EncryptedUploadStatus = serde_json::from_slice(&body).unwrap();
    let chunk = |index: u64, bytes: &[u8]| {
        let header=serde_json::json!({"upload_id":file.upload_id,"owner_id":owner,"conversation_id":conversation,"filename":file.filename,"media_type":file.media_type,"plaintext_size":file.plaintext_size,"index":index,"chunk_size":bytes.len(),"plaintext_sha256":seal::sha256_hex(bytes)}).to_string();
        let mut plain =
            format!("ORKESTR-ATTACHMENT-CHUNK/1\n{}\n{header}", header.len()).into_bytes();
        plain.extend(bytes);
        seal::encrypt(&started.recipients, &plain).unwrap()
    };
    let first = chunk(0, &vec![7; ENCRYPTED_UPLOAD_CHUNK_BYTES as usize]);
    let first_path = format!("{root}/{}/chunks/0", file.upload_id);
    let digest = seal::sha256_hex(&first);
    let (status, _) = call(&socket, &token, "PUT", &first_path, &first, Some(&digest)).await;
    assert_eq!(status, 200);
    let upload = format!("{root}/{}", file.upload_id);
    // The browser token is required to discard; another session cannot.
    assert_eq!(
        call(&socket, &"cd".repeat(32), "DELETE", &upload, b"", None)
            .await
            .0,
        401
    );
    assert_eq!(
        call(&socket, &token, "DELETE", &upload, b"", None).await.0,
        204
    );
    // Discarded: no status, no stored ciphertext, nothing to finish or attach.
    assert_eq!(
        call(&socket, &token, "GET", &upload, b"", None).await.0,
        404
    );
    assert_eq!(
        call(&socket, &token, "GET", &first_path, b"", None).await.0,
        404
    );
    // A chunk still in flight when Cancel was pressed cannot revive it.
    let last = chunk(1, b"end");
    let last_digest = seal::sha256_hex(&last);
    let last_path = format!("{root}/{}/chunks/1", file.upload_id);
    assert_eq!(
        call(
            &socket,
            &token,
            "PUT",
            &last_path,
            &last,
            Some(&last_digest)
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            &socket,
            &token,
            "POST",
            &format!("{upload}/complete"),
            b"[]",
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            &socket,
            &token,
            "POST",
            &format!("{upload}/attachment"),
            b"{}",
            None
        )
        .await
        .0,
        404
    );
    // Discarding twice finds nothing; the browser treats that as done.
    assert_eq!(
        call(&socket, &token, "DELETE", &upload, b"", None).await.0,
        404
    );
    // Reselecting the same file starts from nothing: no old ciphertext.
    let (status, body) = call(&socket, &token, "POST", &root, &start, None).await;
    assert_eq!(status, 200);
    let restarted: EncryptedUploadStatus = serde_json::from_slice(&body).unwrap();
    assert!(restarted.chunks.is_empty() && !restarted.complete);
    assert!(
        !home.join("exports").join(conversation.to_string()).exists()
            || std::fs::read_dir(home.join("exports").join(conversation.to_string()))
                .unwrap()
                .next()
                .is_none(),
        "no provider file for a cancelled upload"
    );
    server.abort();
    let _ = server.await;
    let _ = std::fs::remove_dir_all(home);
}
