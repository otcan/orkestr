use super::*;
use age::secrecy::ExposeSecret;
use orkestr_v2_store_sqlite::{
    attachment_store::{keys::ImportedRecipient, seal},
    Store,
};
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
const TOKEN: &str = "synthetic-token";
#[derive(Default)]
pub(super) struct Pause {
    pub entered: tokio::sync::Notify,
    pub resume: tokio::sync::Notify,
}

#[tokio::test]
async fn cancelling_private_preparation_removes_temporary_file_without_receipt_or_grant() {
    let (root, state, mut status) = fixture(3).await;
    let bytes = ciphertext(&status, 0, b"abc", false);
    let chunk = state
        .store
        .encrypted_upload_put(
            TOKEN,
            &status.owner_id,
            &status.conversation_id,
            status.file.upload_id,
            0,
            &seal::sha256_hex(&bytes),
            &bytes,
        )
        .await
        .unwrap();
    status = state
        .store
        .encrypted_upload_finish(
            TOKEN,
            &status.owner_id,
            &status.conversation_id,
            status.file.upload_id,
            &[chunk],
        )
        .await
        .unwrap();
    let pause = std::sync::Arc::new(Pause::default());
    *state
        .attachment_ingest
        .as_ref()
        .unwrap()
        .pause
        .lock()
        .unwrap() = Some(pause.clone());
    let worker = state.clone();
    let handle = tokio::spawn(async move { materialize(&worker, TOKEN, &status).await });
    pause.entered.notified().await;
    let folder = root.join("exports");
    let conversation_folder = std::fs::read_dir(folder)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let temporary = std::fs::read_dir(&conversation_folder)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        temporary.metadata().unwrap().permissions().mode() & 0o777,
        0o600
    );
    handle.abort();
    assert!(handle.await.unwrap_err().is_cancelled());
    assert_eq!(std::fs::read_dir(conversation_folder).unwrap().count(), 0);
    state.store.close().await;
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn publication_failure_restores_private_permissions_and_does_not_grant_a_file() {
    let root = std::env::temp_dir().join(format!("ingest-publish-fail-{}", Uuid::new_v4()));
    let dir = private_fs::directory(&root, true).unwrap();
    let temporary = private_fs::Temporary {
        dir: dir.try_clone().unwrap(),
        name: "private.tmp".into(),
    };
    let file = private_fs::create(&dir, &temporary.name, 0o600).unwrap();
    std::fs::create_dir(root.join("cannot-replace-directory")).unwrap();
    assert!(publish_prepared(
        &file,
        &dir,
        &temporary.name,
        "cannot-replace-directory",
        None
    )
    .is_err());
    assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    drop(temporary);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn provisioning_is_atomic_retained_on_restart_and_never_replaces_corrupt_identity() {
    let root = std::env::temp_dir().join(format!("ingest-key-provision-{}", Uuid::new_v4()));
    let path = root.join("keys/ingest.age");
    let first = Ingest::provision(&path).unwrap().recipient;
    assert_eq!(Ingest::provision(&path).unwrap().recipient, first);
    let alias = root.join("alias");
    std::os::unix::fs::symlink(root.join("keys"), &alias).unwrap();
    assert!(Ingest::load(&alias.join("ingest.age")).is_err());
    let hardlink = root.join("hardlink.age");
    std::fs::hard_link(&path, &hardlink).unwrap();
    assert!(Ingest::load(&path).is_err());
    std::fs::remove_file(hardlink).unwrap();
    std::fs::write(&path, b"corrupt").unwrap();
    assert!(Ingest::provision(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"corrupt");
    let _ = std::fs::remove_dir_all(root);
}

async fn fixture(size: u64) -> (PathBuf, AppState, EncryptedUploadStatus) {
    let root = std::env::temp_dir().join(format!("encrypted-ingest-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let keypath = root.join("ingest.key");
    let identity = age::x25519::Identity::generate();
    use std::io::Write;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&keypath)
        .unwrap()
        .write_all(identity.to_string().expose_secret().as_bytes())
        .unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
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
    store.save_session(TOKEN, &owner).await.unwrap();
    let browser = age::x25519::Identity::generate().to_public().to_string();
    store
        .import_attachment_recipients(
            &owner,
            &[ImportedRecipient {
                recipient: browser,
                label: "Browser".into(),
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
    .with_attachment_export(ExportDir {
        dir: root.join("exports"),
        gid: None,
    })
    .with_attachment_ingest_file(&keypath)
    .unwrap();
    let descriptor = EncryptedUploadStart {
        upload_id: Uuid::new_v4(),
        filename: "sample.txt".into(),
        media_type: "text/plain".into(),
        plaintext_size: size,
    };
    let status = state
        .store
        .encrypted_upload_start_for_ingest(
            TOKEN,
            &owner,
            &conversation,
            &descriptor,
            Some(&identity.to_public().to_string()),
        )
        .await
        .unwrap();
    (root, state, status)
}

fn ciphertext(status: &EncryptedUploadStatus, index: u64, bytes: &[u8], mutate: bool) -> Vec<u8> {
    let mut header = serde_json::json!({"upload_id":status.file.upload_id,"owner_id":status.owner_id,"conversation_id":status.conversation_id,"filename":status.file.filename,"media_type":status.file.media_type,"plaintext_size":status.file.plaintext_size,"index":index,"chunk_size":bytes.len(),"plaintext_sha256":seal::sha256_hex(bytes)});
    if mutate {
        header["conversation_id"] = serde_json::json!(Uuid::new_v4());
    }
    let header = header.to_string();
    let mut plain = format!("ORKESTR-ATTACHMENT-CHUNK/1\n{}\n{header}", header.len()).into_bytes();
    plain.extend(bytes);
    seal::encrypt(&status.recipients, &plain).unwrap()
}

#[tokio::test]
async fn verified_chunked_ingest_materializes_atomic_provider_file_and_real_receipt() {
    let (root, state, mut status) = fixture(ENCRYPTED_UPLOAD_CHUNK_BYTES + 7).await;
    let chunks = [
        vec![42; ENCRYPTED_UPLOAD_CHUNK_BYTES as usize],
        b"the end".to_vec(),
    ];
    let mut receipts = vec![];
    for (index, bytes) in chunks.iter().enumerate() {
        let bytes = ciphertext(&status, index as u64, bytes, false);
        assert!(bytes.len() <= ENCRYPTED_UPLOAD_CIPHERTEXT_MAX);
        receipts.push(
            state
                .store
                .encrypted_upload_put(
                    TOKEN,
                    &status.owner_id,
                    &status.conversation_id,
                    status.file.upload_id,
                    index as u64,
                    &seal::sha256_hex(&bytes),
                    &bytes,
                )
                .await
                .unwrap(),
        );
    }
    status = state
        .store
        .encrypted_upload_finish(
            TOKEN,
            &status.owner_id,
            &status.conversation_id,
            status.file.upload_id,
            &receipts,
        )
        .await
        .unwrap();
    let receipt = materialize(&state, TOKEN, &status).await.unwrap();
    assert!(receipt.is_valid());
    assert_eq!(
        receipt.attachments[0].byte_length,
        ENCRYPTED_UPLOAD_CHUNK_BYTES + 7
    );
    let folder = root
        .join("exports")
        .join(status.conversation_id.to_string());
    let paths: Vec<_> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(paths.len(), 1);
    assert_eq!(std::fs::read(&paths[0]).unwrap(), chunks.concat());
    assert!(receipt.note.contains(paths[0].to_str().unwrap()));
    assert!(receipt.note.contains(&seal::sha256_hex(&chunks.concat())));
    // Retry republishes the same verified content and reference, not a new file.
    let inode = paths[0].metadata().unwrap().ino();
    assert_eq!(materialize(&state, TOKEN, &status).await.unwrap(), receipt);
    assert_eq!(
        paths[0].metadata().unwrap().ino(),
        inode,
        "idempotent retry reuses the verified file"
    );
    std::fs::write(&paths[0], b"corrupt").unwrap();
    assert_eq!(materialize(&state, TOKEN, &status).await.unwrap(), receipt);
    assert_eq!(
        std::fs::read(&paths[0]).unwrap(),
        chunks.concat(),
        "changed cached exports are fully reconstructed"
    );
    state.store.revoke_session(TOKEN).await.unwrap();
    assert!(materialize(&state, TOKEN, &status).await.is_err());
    state.store.close().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn encrypted_scope_mismatch_never_publishes_plaintext_and_cleans_partial_file() {
    let (root, state, mut status) = fixture(3).await;
    let bytes = ciphertext(&status, 0, b"abc", true);
    let receipt = state
        .store
        .encrypted_upload_put(
            TOKEN,
            &status.owner_id,
            &status.conversation_id,
            status.file.upload_id,
            0,
            &seal::sha256_hex(&bytes),
            &bytes,
        )
        .await
        .unwrap();
    status = state
        .store
        .encrypted_upload_finish(
            TOKEN,
            &status.owner_id,
            &status.conversation_id,
            status.file.upload_id,
            &[receipt],
        )
        .await
        .unwrap();
    assert_eq!(
        materialize(&state, TOKEN, &status).await.unwrap_err(),
        "encrypted chunk scope mismatch"
    );
    let folder = root
        .join("exports")
        .join(status.conversation_id.to_string());
    assert_eq!(std::fs::read_dir(folder).unwrap().count(), 0);
    state.store.close().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn ingest_key_custody_requires_private_regular_file_and_no_symlink() {
    let (root, state, _) = fixture(3).await;
    let key = root.join("ingest.key");
    assert!(Ingest::load(&key).is_ok());
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(Ingest::load(&key).is_err());
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = root.join("alias.key");
    std::os::unix::fs::symlink(&key, &link).unwrap();
    assert!(Ingest::load(&link).is_err());
    state.store.close().await;
    let _ = std::fs::remove_dir_all(root);
}
