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
    let bundle: AttachmentBundle = serde_json::from_slice(&body).unwrap();
    assert_eq!(bundle.manifest, request.target_manifest);
    assert_eq!(bundle.contents[0].bytes, request.source.contents[0].bytes);
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
    assert_eq!(bytes, request.source.contents[0].bytes);
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
