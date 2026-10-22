//! Real HTTP over disposable Unix sockets, without reserving a host TCP port.
use super::*;
use orkestr_v2_contracts::*;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

async fn call(
    socket: &std::path::Path,
    token: &str,
    method: &str,
    path: &str,
    body: &[u8],
) -> (u16, Vec<u8>) {
    let mut stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    let head = format!("{method} /api/v2{path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stream.read_to_end(&mut response),
    )
    .await
    .unwrap()
    .unwrap();
    let split = response.windows(4).position(|v| v == b"\r\n\r\n").unwrap();
    let header_text = std::str::from_utf8(&response[..split])
        .unwrap()
        .to_ascii_lowercase();
    assert!(header_text.contains("\r\ncache-control: no-store"));
    assert!(header_text.contains("\r\nx-content-type-options: nosniff"));
    let status = std::str::from_utf8(&response[..split])
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, response[split + 4..].to_vec())
}
fn request(owner: OwnerId, conversation: ConversationId) -> AttachmentImportRequest {
    let bytes = [b"\0\xffsynthetic\r\n".as_slice(), &[42; 48 * 1024]].concat();
    let reference = AttachmentReference {
        reference_id: Uuid::new_v4(),
        message_id: None,
        filename: "sample.bin".into(),
        media_type: "application/octet-stream".into(),
        byte_length: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        state: AttachmentState::Available,
    };
    let source = AttachmentManifest {
        schema_version: 1,
        manifest_id: Uuid::new_v4(),
        owner_id: OwnerId(Uuid::new_v4()),
        conversation_id: ConversationId(Uuid::new_v4()),
        references: vec![reference.clone()],
    };
    let mut target = source.clone();
    target.owner_id = owner;
    target.conversation_id = conversation;
    target.manifest_id = Uuid::new_v4();
    target.references[0].reference_id = Uuid::new_v4();
    AttachmentImportRequest {
        request_key: "synthetic-transfer".into(),
        mapping: vec![AttachmentReferenceMapping {
            source_reference_id: reference.reference_id,
            target_reference_id: target.references[0].reference_id,
        }],
        source: AttachmentBundle {
            manifest: source,
            contents: vec![AttachmentContent {
                reference_id: reference.reference_id,
                bytes,
            }],
        },
        target_manifest: target,
    }
}
#[tokio::test]
async fn http_persisted_bytes_replay_removal_and_revocation() {
    let (home, state, token) = tests::state().await;
    let owner = state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let conversation = state.store.global(&owner).await.unwrap();
    let request = request(owner, conversation.clone());
    let socket = home.0.join("http.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let app = crate::router(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let lists = format!("/conversations/{conversation}/attachment-manifests");
    let (status, body) = call(&socket, &token, "GET", &lists, b"").await;
    assert_eq!(status, 200);
    let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        page["owner_id"],
        serde_json::to_value(&request.target_manifest.owner_id).unwrap()
    );
    assert_eq!(
        page["conversation_id"],
        serde_json::to_value(&conversation).unwrap()
    );
    assert_eq!(page["manifests"], serde_json::json!([]));
    assert!(page["next_after_id"].is_null());
    for query in [
        "limit=0",
        "limit=17",
        "limit=65536",
        "after_id=invalid",
        "after_id=00000000-0000-0000-0000-000000000000",
        "unknown=value",
    ] {
        assert_eq!(
            call(&socket, &token, "GET", &format!("{lists}?{query}"), b"")
                .await
                .0,
            400
        );
    }
    let imports = format!("/conversations/{conversation}/attachment-imports");
    let mut corrupt = request.clone();
    corrupt.source.contents[0].bytes[0] ^= 1;
    assert_eq!(
        call(
            &socket,
            &token,
            "POST",
            &imports,
            &serde_json::to_vec(&corrupt).unwrap()
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(
            &socket,
            &token,
            "POST",
            &imports,
            br#"{"unexpected":"field"}"#
        )
        .await
        .0,
        422
    );
    let mut inert = request.clone();
    inert.request_key = "synthetic-inert".into();
    inert.source.manifest.manifest_id = Uuid::new_v4();
    inert.target_manifest.manifest_id = Uuid::new_v4();
    inert.source.manifest.references[0].state = AttachmentState::Inert;
    inert.source.manifest.references[0].byte_length = u64::MAX;
    inert.source.manifest.references[0].filename = "../legacy-descriptor".into();
    inert.target_manifest.references[0] = inert.source.manifest.references[0].clone();
    inert.target_manifest.references[0].reference_id = Uuid::new_v4();
    inert.mapping[0].target_reference_id = inert.target_manifest.references[0].reference_id;
    inert.source.contents.clear();
    assert_eq!(
        call(
            &socket,
            &token,
            "POST",
            &imports,
            &serde_json::to_vec(&inert).unwrap()
        )
        .await
        .0,
        200
    );
    let inert_path = format!(
        "/conversations/{conversation}/attachments/{}/{}",
        inert.target_manifest.manifest_id, inert.target_manifest.references[0].reference_id
    );
    assert_eq!(call(&socket, &token, "GET", &inert_path, b"").await.0, 409);
    let body = serde_json::to_vec(&request).unwrap();
    let (status, receipt) = call(&socket, &token, "POST", &imports, &body).await;
    assert_eq!(status, 200);
    assert_eq!(
        call(&socket, &token, "POST", &imports, &body).await,
        (200, receipt)
    );
    let (status, body) = call(&socket, &token, "GET", &format!("{lists}?limit=1"), b"").await;
    assert_eq!(status, 200);
    let first: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(first["manifests"].as_array().unwrap().len(), 1);
    let cursor = first["next_after_id"]
        .as_str()
        .expect("second manifest remains");
    let (status, body) = call(
        &socket,
        &token,
        "GET",
        &format!("{lists}?limit=1&after_id={cursor}"),
        b"",
    )
    .await;
    assert_eq!(status, 200);
    let second: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(second["manifests"].as_array().unwrap().len(), 1);
    assert!(second["next_after_id"].is_null());
    assert_ne!(
        first["manifests"][0]["manifest_id"],
        second["manifests"][0]["manifest_id"]
    );
    assert_eq!(second["after_id"], cursor);
    let manifest = request.target_manifest.manifest_id;
    let reference = request.target_manifest.references[0].reference_id;
    let download = format!("/conversations/{conversation}/attachments/{manifest}/{reference}");
    assert_eq!(
        call(&socket, &token, "GET", &download, b"").await,
        (200, request.source.contents[0].bytes.clone())
    );
    let export = format!("/conversations/{conversation}/attachment-manifests/{manifest}/export");
    let (status, body) = call(&socket, &token, "GET", &export, b"").await;
    assert_eq!(status, 200);
    let bundle: StoredAttachmentBundle = serde_json::from_slice(&body).unwrap();
    assert_eq!(bundle.manifest, request.target_manifest);
    assert_eq!(bundle.contents[0].bytes, request.source.contents[0].bytes);
    assert_eq!(bundle.contents[0].format, StoredAttachmentFormat::Plain);
    let foreign = download.replace(&conversation.to_string(), &Uuid::new_v4().to_string());
    assert_eq!(call(&socket, &token, "GET", &foreign, b"").await.0, 404);
    assert_eq!(
        call(
            &socket,
            &token,
            "DELETE",
            &download,
            br#"{"request_key":"synthetic-removal"}"#
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(
            &socket,
            &token,
            "POST",
            &imports,
            &serde_json::to_vec(&request).unwrap()
        )
        .await
        .0,
        200
    );
    assert_eq!(call(&socket, &token, "GET", &download, b"").await.0, 410);
    state.store.revoke_session(&token).await.unwrap();
    assert_eq!(
        call(
            &socket,
            &token,
            "POST",
            &imports,
            &serde_json::to_vec(&request).unwrap()
        )
        .await
        .0,
        401
    );
    assert_eq!(call(&socket, &token, "GET", &lists, b"").await.0, 401);
    server.abort();
    let _ = server.await;
    state.store.close().await;
}

// The test executable is the owned synthetic server; no external binary or
// production environment is inherited. Only this exact helper is selected.
#[test]
fn disposable_http_child() {
    let Some(home) = std::env::var_os("ATTACHMENT_SYNTHETIC_CHILD_HOME") else {
        return;
    };
    let home = std::path::PathBuf::from(home);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let store = orkestr_v2_store_sqlite::Store::open(&home.join("state.sqlite3"))
            .await
            .unwrap();
        let state = crate::AppState::new(
            store,
            "synthetic-bootstrap-token-long-enough".into(),
            "http://localhost:43123".into(),
        )
        .unwrap();
        let listener = tokio::net::UnixListener::bind(home.join("child.sock")).unwrap();
        axum::serve(listener, crate::router(state)).await.unwrap();
    });
}
struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[tokio::test]
async fn owned_http_process_kill_reopen_preserves_exact_bytes() {
    let (home, state, token) = tests::state().await;
    let owner = state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let conversation = state.store.global(&owner).await.unwrap();
    let request = request(owner, conversation.clone());
    let mut child = Child(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "attachment_transfer::http_tests::disposable_http_child",
                "--nocapture",
            ])
            .env_clear()
            .env("ATTACHMENT_SYNTHETIC_CHILD_HOME", &home.0)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let socket = home.0.join("child.sock");
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while !socket.exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "owned helper exited before listening"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let imports = format!("/conversations/{conversation}/attachment-imports");
    assert_eq!(
        call(
            &socket,
            &token,
            "POST",
            &imports,
            &serde_json::to_vec(&request).unwrap()
        )
        .await
        .0,
        200
    );
    child.0.kill().unwrap();
    let status = child.0.wait().unwrap();
    assert!(!status.success());
    state.store.close().await;
    let reopened = orkestr_v2_store_sqlite::Store::open(&home.0.join("state.sqlite3"))
        .await
        .unwrap();
    let (_, bytes) = reopened
        .download_attachment_authenticated(
            &token,
            &request.target_manifest.owner_id,
            &conversation,
            request.target_manifest.manifest_id,
            request.target_manifest.references[0].reference_id,
        )
        .await
        .unwrap();
    assert_eq!(
        bytes,
        orkestr_v2_store_sqlite::attachment_store::StoredObject::Plain(
            request.source.contents[0].bytes.clone()
        )
    );
    assert_eq!(
        reopened
            .import_attachment_bundle_authenticated(
                &token,
                &request.target_manifest.owner_id,
                &conversation,
                &request
            )
            .await
            .unwrap()
            .manifest,
        request.target_manifest
    );
    reopened.close().await;
}

/// Browser enrollment and sealed objects over real HTTP: the download and the
/// export carry age ciphertext only; without an active key, uploads fail closed.
#[tokio::test]
async fn http_sealed_download_enrollment_and_fail_closed() {
    use std::io::Read;
    let (home, state, token) = tests::state().await;
    let owner = state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let conversation = state.store.global(&owner).await.unwrap();
    let socket = home.0.join("sealed.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let app = crate::router(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let json = |body: Vec<u8>| serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    let decrypt = |identity: &age::x25519::Identity, bytes: &[u8]| -> Option<Vec<u8>> {
        let mut out = Vec::new();
        age::Decryptor::new(bytes)
            .ok()?
            .decrypt(std::iter::once(identity as &dyn age::Identity))
            .ok()?
            .read_to_end(&mut out)
            .ok()?;
        Some(out)
    };
    // Requiring encryption needs an enrolled key first.
    let (status, body) = call(
        &socket,
        &token,
        "POST",
        "/attachment-keys/policy",
        br#"{"required":true}"#,
    )
    .await;
    assert_eq!(
        (status, json(body)["code"].clone()),
        (409, "attachment_encryption_key_required".into())
    );
    let identity = age::x25519::Identity::generate();
    let recipient = identity.to_public().to_string();
    let registration = serde_json::json!({"recipient": recipient, "label": "Synthetic browser"});
    let (status, body) = call(
        &socket,
        &token,
        "POST",
        "/attachment-keys",
        registration.to_string().as_bytes(),
    )
    .await;
    assert_eq!(status, 200);
    let pending = json(body);
    assert_eq!(pending["status"], "pending_verification");
    let challenge = crate::message_attachments::decode_base64(
        pending["challenge"]["ciphertext_base64"].as_str().unwrap(),
    )
    .unwrap();
    let proof = String::from_utf8(decrypt(&identity, &challenge).unwrap()).unwrap();
    let id = pending["id"].as_str().unwrap();
    let verify = format!("/attachment-keys/{id}/verify");
    let (status, _) = call(&socket, &token, "POST", &verify, br#"{"proof":"wrong"}"#).await;
    assert_eq!(status, 400);
    let (status, body) = call(
        &socket,
        &token,
        "POST",
        &verify,
        serde_json::json!({"proof": proof}).to_string().as_bytes(),
    )
    .await;
    assert_eq!(
        (status, json(body)["status"].clone()),
        (200, "active".into())
    );
    let (status, body) = call(
        &socket,
        &token,
        "POST",
        "/attachment-keys/policy",
        br#"{"required":true}"#,
    )
    .await;
    assert_eq!((status, json(body)["required"].clone()), (200, true.into()));

    let request = request(owner, conversation.clone());
    let plain = request.source.contents[0].bytes.clone();
    let imports = format!("/conversations/{conversation}/attachment-imports");
    let (status, _) = call(
        &socket,
        &token,
        "POST",
        &imports,
        &serde_json::to_vec(&request).unwrap(),
    )
    .await;
    assert_eq!(status, 200);
    let manifest = request.target_manifest.manifest_id;
    let reference = request.target_manifest.references[0].reference_id;
    let download = format!("/conversations/{conversation}/attachments/{manifest}/{reference}");
    let (status, ciphertext) = call(&socket, &token, "GET", &download, b"").await;
    assert_eq!(status, 200);
    assert!(ciphertext.starts_with(b"age-encryption.org/v1\n"));
    assert!(!ciphertext
        .windows(b"synthetic".len())
        .any(|w| w == b"synthetic"));
    let payload = decrypt(&identity, &ciphertext).unwrap();
    assert!(payload.starts_with(b"ORKESTR-ATTACHMENT-PAYLOAD/1\n"));
    assert!(payload.ends_with(&plain));
    let export = format!("/conversations/{conversation}/attachment-manifests/{manifest}/export");
    let (status, body) = call(&socket, &token, "GET", &export, b"").await;
    assert_eq!(status, 200);
    let bundle: StoredAttachmentBundle = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        bundle.contents[0].format,
        StoredAttachmentFormat::AgeX25519V1
    );
    assert_eq!(bundle.contents[0].bytes, ciphertext);
    let (status, body) = call(&socket, &token, "GET", "/attachment-keys", b"").await;
    let status_body = json(body);
    assert_eq!(status, 200);
    assert_eq!(
        (
            status_body["plaintext_objects"].clone(),
            status_body["sealed_objects"].clone()
        ),
        (0.into(), 1.into())
    );
    assert!(status_body["keys"][0].get("challenge").unwrap().is_null());

    // Revoking the only key leaves the required policy: new uploads fail closed.
    let (status, _) = call(
        &socket,
        &token,
        "POST",
        &format!("/attachment-keys/{id}/revoke"),
        br#"{"reason":"synthetic"}"#,
    )
    .await;
    assert_eq!(status, 200);
    let mut later = request.clone();
    later.request_key = "after-revoke".into();
    later.target_manifest.manifest_id = Uuid::new_v4();
    later.target_manifest.references[0].reference_id = Uuid::new_v4();
    later.mapping[0].target_reference_id = later.target_manifest.references[0].reference_id;
    let (status, body) = call(
        &socket,
        &token,
        "POST",
        &imports,
        &serde_json::to_vec(&later).unwrap(),
    )
    .await;
    assert_eq!(
        (status, json(body)["error"].clone()),
        (409, "attachment_encryption_key_required".into())
    );
    let (status, _) = call(
        &socket,
        "cd".repeat(32).as_str(),
        "GET",
        "/attachment-keys",
        b"",
    )
    .await;
    assert_eq!(status, 401);
    server.abort();
    state.store.close().await;
}
