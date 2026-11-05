//! Manual actual1GB HTTP + SQL backup/restore acceptance. Not normal CI work.
use super::*;
use crate::message_attachments::ExportDir;
use sha2::{Digest, Sha256};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};
use tokio::io::AsyncReadExt;

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn rss_kib(field: &str) -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|line| {
            line.strip_prefix(field)
                .and_then(|v| v.split_whitespace().next())
                .and_then(|v| v.parse().ok())
        })
        .unwrap()
}
fn disk_bytes(path: &Path) -> u64 {
    std::fs::read_dir(path)
        .unwrap()
        .map(|entry| {
            let p = entry.unwrap().path();
            if p.is_dir() {
                disk_bytes(&p)
            } else {
                p.metadata().unwrap().len()
            }
        })
        .sum()
}
async fn checksum(path: &Path) -> (u64, String) {
    let mut file = tokio::fs::File::open(path).await.unwrap();
    let mut buffer = vec![0; ENCRYPTED_UPLOAD_CHUNK_BYTES as usize];
    let mut hash = Sha256::new();
    let mut size = 0;
    loop {
        let n = file.read(&mut buffer).await.unwrap();
        if n == 0 {
            break;
        }
        size += n as u64;
        hash.update(&buffer[..n]);
    }
    (size, format!("{:x}", hash.finalize()))
}
fn state(store: Store, home: &Path) -> AppState {
    AppState::new(
        store,
        "synthetic-bootstrap-token-long-enough".into(),
        "http://localhost:43123".into(),
    )
    .unwrap()
    .with_attachment_export(ExportDir {
        dir: home.join("exports"),
        gid: None,
    })
    .with_attachment_ingest_home(home)
    .unwrap()
}
async fn serve(home: &Path, state: AppState) -> (PathBuf, tokio::task::JoinHandle<()>) {
    let socket = home.join("http.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    (
        socket,
        tokio::spawn(async move { axum::serve(listener, crate::router(state)).await.unwrap() }),
    )
}
async fn json_call<T: serde::de::DeserializeOwned>(
    socket: &Path,
    token: &str,
    method: &str,
    path: &str,
    body: &[u8],
) -> T {
    let (status, body) = super::call_with_timeout(
        socket,
        token,
        method,
        path,
        body,
        None,
        std::time::Duration::from_secs(20 * 60),
    )
    .await;
    assert_eq!(
        status,
        200,
        "{method} {path}: {}",
        String::from_utf8_lossy(&body)
    );
    serde_json::from_slice(&body).unwrap()
}
fn payload(status: &EncryptedUploadStatus, index: u64, plain: &[u8]) -> Vec<u8> {
    let header=serde_json::json!({"upload_id":status.file.upload_id,"owner_id":status.owner_id,"conversation_id":status.conversation_id,"filename":status.file.filename,"media_type":status.file.media_type,"plaintext_size":status.file.plaintext_size,"index":index,"chunk_size":plain.len(),"plaintext_sha256":seal::sha256_hex(plain)}).to_string();
    let mut out = format!("ORKESTR-ATTACHMENT-CHUNK/1\n{}\n{header}", header.len()).into_bytes();
    out.extend_from_slice(plain);
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual actual1GB transfer: requires ORKESTR_V2_RUN_LARGE_UPLOAD_ACCEPTANCE=1 and disposable scratch"]
async fn actual_1gb_http_backup_restore_and_provider_reconstruction() {
    assert_eq!(
        std::env::var("ORKESTR_V2_RUN_LARGE_UPLOAD_ACCEPTANCE").as_deref(),
        Ok("1")
    );
    let base = PathBuf::from(
        std::env::var_os("ORKESTR_V2_LARGE_UPLOAD_SCRATCH").expect("explicit disposable scratch"),
    );
    assert!(base.is_absolute());
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&base)
        .unwrap();
    let scratch = Scratch(base.join(format!("actual-1gb-{}", Uuid::new_v4())));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&scratch.0)
        .unwrap();
    let source = scratch.0.join("source");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&source)
        .unwrap();
    let started = Instant::now();
    let initial_rss = rss_kib("VmRSS:");
    let store = Store::open(&source.join("core.sqlite3")).await.unwrap();
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
    let browser = age::x25519::Identity::generate();
    store
        .import_attachment_recipients(
            &owner,
            &[ImportedRecipient {
                recipient: browser.to_public().to_string(),
                label: "Synthetic browser".into(),
                verified_at: 1,
            }],
        )
        .await
        .unwrap();
    let (socket, server) = serve(&source, state(store.clone(), &source)).await;
    let root = format!("/api/v2/conversations/{conversation}/encrypted-uploads");
    let id = Uuid::new_v4();
    let mut descriptor = EncryptedUploadStart {
        upload_id: id,
        filename: "actual-1gb.bin".into(),
        media_type: "application/octet-stream".into(),
        plaintext_size: ENCRYPTED_UPLOAD_MAX_BYTES + 1,
    };
    let (status, _) = super::call(
        &socket,
        &token,
        "POST",
        &root,
        &serde_json::to_vec(&descriptor).unwrap(),
        None,
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(
        super::call(&socket, &token, "GET", &format!("{root}/{id}"), b"", None)
            .await
            .0,
        404
    );
    descriptor.plaintext_size = ENCRYPTED_UPLOAD_MAX_BYTES;
    let status: EncryptedUploadStatus = json_call(
        &socket,
        &token,
        "POST",
        &root,
        &serde_json::to_vec(&descriptor).unwrap(),
    )
    .await;
    let mut receipts = Vec::new();
    let mut expected = Sha256::new();
    let mut sent = 0u64;
    let upload_started = Instant::now();
    let mut max_chunk = 0;
    for index in 0..descriptor.chunk_count() {
        let plain = vec![(index % 251) as u8; descriptor.chunk_size(index).unwrap() as usize];
        expected.update(&plain);
        sent += plain.len() as u64;
        let ciphertext =
            seal::encrypt(&status.recipients, &payload(&status, index, &plain)).unwrap();
        max_chunk = max_chunk.max(ciphertext.len());
        assert!(ciphertext.len() <= ENCRYPTED_UPLOAD_CIPHERTEXT_MAX);
        let (code, body) = super::call(
            &socket,
            &token,
            "PUT",
            &format!("{root}/{id}/chunks/{index}"),
            &ciphertext,
            Some(&seal::sha256_hex(&ciphertext)),
        )
        .await;
        assert_eq!(code, 200, "{}", String::from_utf8_lossy(&body));
        receipts.push(serde_json::from_slice::<EncryptedUploadChunk>(&body).unwrap());
        // Disconnect/reopen after a committed prefix and confirm durable resume.
        if index == 31 {
            let resumed: EncryptedUploadStatus = json_call(
                &socket,
                &token,
                "POST",
                &root,
                &serde_json::to_vec(&descriptor).unwrap(),
            )
            .await;
            assert_eq!(resumed.chunks, receipts);
        }
        if index % 128 == 0 {
            eprintln!(
                "actual1GB acceptance: uploaded {sent} plaintext bytes, currentRSS={}KiB",
                rss_kib("VmRSS:")
            );
        }
    }
    assert_eq!(sent, 1_000_000_000);
    let expected_sha = format!("{:x}", expected.finalize());
    let upload_seconds = upload_started.elapsed().as_secs_f64();
    eprintln!("actual1GB acceptance: transferred all {sent} plaintext bytes in {upload_seconds:.3}s; completing and preparing provider file");
    let completed: EncryptedUploadStatus = json_call(
        &socket,
        &token,
        "POST",
        &format!("{root}/{id}/complete"),
        &serde_json::to_vec(&receipts).unwrap(),
    )
    .await;
    assert!(completed.complete);
    let materialize_started = Instant::now();
    let receipt: MessageAttachmentReceipt = json_call(
        &socket,
        &token,
        "POST",
        &format!("{root}/{id}/attachment"),
        b"{}",
    )
    .await;
    assert!(receipt.is_valid());
    assert_eq!(receipt.attachments[0].byte_length, sent);
    let materialize_seconds = materialize_started.elapsed().as_secs_f64();
    eprintln!("actual1GB acceptance: provider materialization completed in {materialize_seconds:.3}s; verifying complete file");
    let provider = source
        .join("exports")
        .join(conversation.to_string())
        .join(format!("{id}.bin"));
    assert_eq!(checksum(&provider).await, (sent, expected_sha.clone()));
    assert!(receipt.note.contains(&expected_sha));
    let wal_bytes = std::fs::metadata(source.join("core.sqlite3-wal"))
        .map(|m| m.len())
        .unwrap_or(0);
    let peak_before_backup = rss_kib("VmHWM:");
    server.abort();
    let _ = server.await;
    store.close().await;
    // Backup is SQLite's online backup API, not an uncheckpointed filesystem copy.
    let backup = scratch.0.join("backup.sqlite3");
    let backup_started = Instant::now();
    let result=std::process::Command::new("python3").args(["-I","-S","-B","-c",r#"import sqlite3,sys,json,time
with sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True) as source, sqlite3.connect(sys.argv[2]) as target:
 source.backup(target,pages=256,sleep=0.01)
 assert target.execute('PRAGMA integrity_check').fetchone()==('ok',)
 assert not target.execute('PRAGMA foreign_key_check').fetchall()
 assert target.execute('SELECT count(*) FROM encrypted_upload_chunks').fetchone()[0]==954
 id=target.execute('SELECT id FROM encrypted_uploads LIMIT 1').fetchone()[0]
 query='SELECT chunk_index,length(ciphertext) AS size,ciphertext_sha256 FROM encrypted_upload_chunks WHERE upload_id=? ORDER BY chunk_index'
 started=time.monotonic(); receipts=target.execute(query,(id,)).fetchall()
 print(json.dumps({'metadata_query_seconds':time.monotonic()-started,'receipt_rows':len(receipts),'query_plan':target.execute('EXPLAIN QUERY PLAN '+query,(id,)).fetchall()}))
"#]).arg(source.join("core.sqlite3")).arg(&backup).env("PYTHONDONTWRITEBYTECODE","1").output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let backup_seconds = backup_started.elapsed().as_secs_f64();
    let sql_backup_report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    eprintln!("actual1GB acceptance: SQLite backup and integrity/FK checks completed in {backup_seconds:.3}s");
    let backup_bytes = backup.metadata().unwrap().len();
    let key_backup = scratch.0.join("ingest.age");
    std::fs::copy(source.join("keys/attachment-ingest.age"), &key_backup).unwrap();
    // Prove reconstruction uses only restored SQL ciphertext and the saved key.
    std::fs::remove_dir_all(&source).unwrap();
    let restored = scratch.0.join("restored");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&restored)
        .unwrap();
    std::fs::copy(&backup, restored.join("core.sqlite3")).unwrap();
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(restored.join("keys"))
        .unwrap();
    std::fs::copy(&key_backup, restored.join("keys/attachment-ingest.age")).unwrap();
    std::fs::set_permissions(
        restored.join("keys/attachment-ingest.age"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let restore_started = Instant::now();
    let restored_store = Store::open(&restored.join("core.sqlite3")).await.unwrap();
    let restore_open_seconds = restore_started.elapsed().as_secs_f64();
    let restored_status = restored_store
        .encrypted_upload_status(&token, &owner, &conversation, id)
        .await
        .unwrap();
    assert_eq!(restored_status, completed);
    // Read every restored ciphertext through its authenticated checksum port.
    for chunk in &receipts {
        let bytes = restored_store
            .encrypted_upload_chunk(&token, &owner, &conversation, id, chunk.index)
            .await
            .unwrap();
        assert_eq!(bytes.len() as u64, chunk.ciphertext_size);
        assert_eq!(seal::sha256_hex(&bytes), chunk.ciphertext_sha256);
    }
    let (socket, server) = serve(&restored, state(restored_store.clone(), &restored)).await;
    let reconstruction_started = Instant::now();
    let rebuilt: MessageAttachmentReceipt = json_call(
        &socket,
        &token,
        "POST",
        &format!("{root}/{id}/attachment"),
        b"{}",
    )
    .await;
    assert_eq!(rebuilt.attachments, receipt.attachments);
    let reconstruction_seconds = reconstruction_started.elapsed().as_secs_f64();
    let rebuilt_path = restored
        .join("exports")
        .join(conversation.to_string())
        .join(format!("{id}.bin"));
    assert_eq!(checksum(&rebuilt_path).await, (sent, expected_sha.clone()));
    let final_artifact_bytes = disk_bytes(&scratch.0);
    assert!(
        final_artifact_bytes < 8 * 1024 * 1024 * 1024,
        "manual acceptance exceeded scratch budget"
    );
    let peak_rss = rss_kib("VmHWM:");
    server.abort();
    let _ = server.await;
    restored_store.close().await;
    std::fs::remove_dir_all(&scratch.0).unwrap();
    assert!(!scratch.0.exists());
    println!(
        "LARGE_UPLOAD_ACCEPTANCE={}",
        serde_json::json!({"plaintext_bytes":sent,"sha256":expected_sha,"chunks":receipts.len(),"max_ciphertext_chunk_bytes":max_chunk,"initial_rss_kib":initial_rss,"peak_before_backup_rss_kib":peak_before_backup,"process_peak_rss_kib":peak_rss,"upload_seconds":upload_seconds,"materialize_seconds":materialize_seconds,"backup_seconds":backup_seconds,"backup_bytes":backup_bytes,"wal_bytes_before_close":wal_bytes,"restore_open_seconds":restore_open_seconds,"reconstruction_seconds":reconstruction_seconds,"final_artifact_bytes":final_artifact_bytes,"total_seconds":started.elapsed().as_secs_f64(),"limit_plus_one_rejected_before_transfer":true,"resume_prefix_verified":true,"sqlite_integrity_and_foreign_keys_verified":true,"every_restored_chunk_verified":true,"provider_reconstruction_verified":true,"scratch_cleaned":true,"debug_assertions":cfg!(debug_assertions),"sql_backup_report":sql_backup_report,"browser_and_reverse_proxy_acceptance":"pending"})
    );
}
