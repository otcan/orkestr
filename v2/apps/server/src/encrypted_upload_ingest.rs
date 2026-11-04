//! Explicit service-readable ingest capability. The operator provisions its age
//! identity in a private0600 file; Core only persists its public recipient.
//! Ciphertext is verified/decrypted one bounded chunk at a time. Provider files
//! appear atomically only after all bindings/checksums and auth are verified.
use crate::{message_attachments::ExportDir, AppState};
use orkestr_v2_contracts::*;
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path, str::FromStr};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

mod prepared;
#[cfg(unix)]
mod private_fs;
#[cfg(all(test, unix))]
mod tests;

pub struct Ingest {
    identity: age::x25519::Identity,
    pub(crate) recipient: String,
    /// Bound concurrent decrypt/export jobs independently of file size.
    exports: tokio::sync::Semaphore,
    pub(crate) lifecycle: tokio::sync::RwLock<()>,
    prepared: prepared::Prepared,
    #[cfg(all(test, unix))]
    pause: std::sync::Mutex<Option<std::sync::Arc<tests::Pause>>>,
}
impl Ingest {
    #[cfg(unix)]
    pub fn load(path: &Path) -> Result<Self, &'static str> {
        let dir = private_fs::directory(path.parent().ok_or("identity parent missing")?, false)?;
        let name = path.file_name().ok_or("identity filename missing")?;
        let file: std::fs::File = rustix::fs::openat(
            &dir,
            name,
            rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(|_| "attachment ingest identity unavailable")?
        .into();
        let meta =
            rustix::fs::fstat(&file).map_err(|_| "attachment ingest identity unavailable")?;
        if rustix::fs::FileType::from_raw_mode(meta.st_mode) != rustix::fs::FileType::RegularFile
            || meta.st_mode & 0o777 != 0o600
            || meta.st_nlink != 1
            || meta.st_size > 4096
            || ![0, rustix::process::geteuid().as_raw()].contains(&meta.st_uid)
        {
            return Err("attachment ingest identity custody rejected");
        }
        let mut bytes = String::new();
        file.take(4097)
            .read_to_string(&mut bytes)
            .map_err(|_| "attachment ingest identity unavailable")?;
        let identity = age::x25519::Identity::from_str(bytes.trim())
            .map_err(|_| "invalid attachment ingest identity")?;
        Ok(Self {
            recipient: identity.to_public().to_string(),
            identity,
            exports: tokio::sync::Semaphore::new(2),
            lifecycle: tokio::sync::RwLock::new(()),
            prepared: Default::default(),
            #[cfg(all(test, unix))]
            pause: Default::default(),
        })
    }
    #[cfg(unix)]
    pub fn provision(path: &Path) -> Result<Self, &'static str> {
        use age::secrecy::ExposeSecret;
        use std::io::Write;
        let dir = private_fs::directory(path.parent().ok_or("identity parent missing")?, true)?;
        // Existing unreadable/corrupt identities are never replaced.
        match rustix::fs::statat(
            &dir,
            path.file_name().ok_or("identity filename missing")?,
            rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
        ) {
            Ok(_) => return Self::load(path),
            Err(rustix::io::Errno::NOENT) => {}
            Err(_) => return Err("identity inspection failed"),
        }
        let temporary = private_fs::Temporary {
            dir: dir
                .try_clone()
                .map_err(|_| "identity directory unavailable")?,
            name: format!(".ingest-{}.tmp", Uuid::new_v4()),
        };
        let mut file = private_fs::create(&dir, &temporary.name, 0o600)?;
        let identity = age::x25519::Identity::generate();
        file.write_all(identity.to_string().expose_secret().as_bytes())
            .map_err(|_| "identity write failed")?;
        file.sync_all().map_err(|_| "identity sync failed")?;
        match rustix::fs::linkat(
            &dir,
            &temporary.name,
            &dir,
            path.file_name().ok_or("identity filename missing")?,
            rustix::fs::AtFlags::empty(),
        ) {
            Ok(()) => {}
            Err(rustix::io::Errno::EXIST) => {}
            Err(_) => return Err("identity publication failed"),
        }
        drop(temporary);
        dir.sync_all()
            .map_err(|_| "identity directory sync failed")?;
        Self::load(path)
    }
    #[cfg(not(unix))]
    pub fn load(_: &Path) -> Result<Self, &'static str> {
        Err("private attachment ingest key custody unavailable")
    }
}

fn opened(
    ingest: &Ingest,
    status: &EncryptedUploadStatus,
    index: u64,
    ciphertext: &[u8],
) -> Result<Vec<u8>, &'static str> {
    let decryptor = age::Decryptor::new(ciphertext).map_err(|_| "invalid age chunk")?;
    let reader = decryptor
        .decrypt(std::iter::once(&ingest.identity as &dyn age::Identity))
        .map_err(|_| "age chunk recipient mismatch")?;
    let mut plain = Vec::new();
    reader
        .take(ENCRYPTED_UPLOAD_CHUNK_BYTES + 4097)
        .read_to_end(&mut plain)
        .map_err(|_| "age chunk authentication failed")?;
    if plain.len() > ENCRYPTED_UPLOAD_CHUNK_BYTES as usize + 4096 {
        return Err("decrypted chunk too large");
    }
    let a = plain
        .iter()
        .position(|b| *b == b'\n')
        .ok_or("invalid chunk framing")?;
    let b = a
        + 1
        + plain[a + 1..]
            .iter()
            .position(|b| *b == b'\n')
            .ok_or("invalid chunk framing")?;
    if &plain[..a] != b"ORKESTR-ATTACHMENT-CHUNK/1" {
        return Err("invalid chunk format");
    }
    let n = std::str::from_utf8(&plain[a + 1..b])
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v > 0 && *v <= 4096)
        .ok_or("invalid chunk header")?;
    let end = (b + 1)
        .checked_add(n)
        .filter(|v| *v <= plain.len())
        .ok_or("truncated chunk")?;
    let mut header: serde_json::Value =
        serde_json::from_slice(&plain[b + 1..end]).map_err(|_| "invalid chunk metadata")?;
    let checksum = header
        .as_object_mut()
        .and_then(|v| v.remove("plaintext_sha256"))
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or("missing plaintext checksum")?;
    let expected = serde_json::json!({"upload_id":status.file.upload_id,"owner_id":status.owner_id,"conversation_id":status.conversation_id,"filename":status.file.filename,"media_type":status.file.media_type,"plaintext_size":status.file.plaintext_size,"index":index,"chunk_size":status.file.chunk_size(index).ok_or("invalid chunk index")?});
    if header != expected {
        return Err("encrypted chunk scope mismatch");
    }
    let content = plain.split_off(end);
    if Some(content.len() as u64) != status.file.chunk_size(index)
        || format!("{:x}", Sha256::digest(&content)) != checksum
    {
        return Err("plaintext chunk checksum mismatch");
    }
    Ok(content)
}

pub(crate) async fn materialize(
    state: &AppState,
    credential: &str,
    status: &EncryptedUploadStatus,
) -> Result<MessageAttachmentReceipt, &'static str> {
    let ingest = state
        .attachment_ingest
        .as_ref()
        .ok_or("attachment ingest not configured")?;
    let _job = ingest.prepared.acquire(status.file.upload_id).await;
    let _lifecycle = ingest.lifecycle.read().await;
    if !status.complete || status.ingest_recipient.as_deref() != Some(&ingest.recipient) {
        return Err("attachment ingest recipient changed or upload incomplete");
    }
    let ExportDir { dir, gid } = state
        .attachment_export
        .as_deref()
        .ok_or("provider export unavailable")?;
    let folder = dir.join(status.conversation_id.to_string());
    let root_fd = private_fs::directory(dir, true)?;
    let folder_fd = private_fs::directory(&folder, true)?;
    if let Some(receipt) = ingest
        .prepared
        .cached(status, &folder_fd, &export_name(status))
    {
        state
            .store
            .encrypted_upload_publish(
                credential,
                &status.owner_id,
                &status.conversation_id,
                status,
                || Ok(()),
            )
            .await
            .map_err(|_| "prepared attachment authorization expired")?;
        return Ok(receipt);
    }
    let _permit = ingest
        .exports
        .try_acquire()
        .map_err(|_| "attachment preparation busy")?;
    rustix::fs::fchmod(&root_fd, rustix::fs::Mode::from_raw_mode(0o750))
        .map_err(|_| "export permissions failed")?;
    rustix::fs::fchmod(&folder_fd, rustix::fs::Mode::from_raw_mode(0o750))
        .map_err(|_| "export permissions failed")?;
    let temporary = private_fs::Temporary {
        dir: folder_fd
            .try_clone()
            .map_err(|_| "export directory unavailable")?,
        name: format!(".{}.{}.tmp", status.file.upload_id, Uuid::new_v4()),
    };
    let file = private_fs::create(&folder_fd, &temporary.name, 0o600)?;
    let mut file = tokio::fs::File::from_std(file);
    #[cfg(all(test, unix))]
    let pause = ingest.pause.lock().unwrap().clone();
    #[cfg(all(test, unix))]
    if let Some(pause) = pause {
        pause.entered.notify_one();
        pause.resume.notified().await;
    }
    let mut total = 0u64;
    let mut hash = Sha256::new();
    for chunk in &status.chunks {
        let bytes = state
            .store
            .encrypted_upload_chunk(
                credential,
                &status.owner_id,
                &status.conversation_id,
                status.file.upload_id,
                chunk.index,
            )
            .await
            .map_err(|_| "encrypted chunk unavailable")?;
        let plain = opened(ingest, status, chunk.index, &bytes)?;
        total += plain.len() as u64;
        if total > status.file.plaintext_size {
            return Err("plaintext exceeds declared file size");
        }
        hash.update(&plain);
        file.write_all(&plain)
            .await
            .map_err(|_| "provider export write failed")?;
    }
    if total != status.file.plaintext_size {
        return Err("incomplete provider export");
    }
    // Recheck live authority and immutable receipts before publishing bytes.
    let current = state
        .store
        .encrypted_upload_status(
            credential,
            &status.owner_id,
            &status.conversation_id,
            status.file.upload_id,
        )
        .await
        .map_err(|_| "upload authorization expired")?;
    if current != *status {
        return Err("upload changed during export");
    }
    file.sync_all()
        .await
        .map_err(|_| "provider export sync failed")?;
    let file = file.into_std().await;
    if let Some(gid) = gid {
        let group = rustix::process::Gid::from_raw(*gid);
        rustix::fs::fchown(&root_fd, None, Some(group))
            .and_then(|_| rustix::fs::fchown(&folder_fd, None, Some(group)))
            .map_err(|_| "provider export ownership failed")?;
    }
    let digest = format!("{:x}", hash.finalize());
    let name = export_name(status);
    let path = folder.join(&name);
    let named_fd = private_fs::directory(&folder, false)?;
    if !private_fs::same_directory(&folder_fd, &named_fd) {
        return Err("export directory changed");
    }
    state
        .store
        .encrypted_upload_publish(
            credential,
            &status.owner_id,
            &status.conversation_id,
            status,
            || publish_prepared(&file, &folder_fd, &temporary.name, &name, *gid),
        )
        .await
        .map_err(|_| "provider publication authorization failed")?;
    let summary = MessageAttachmentSummary {
        attachment_id: status.file.upload_id.to_string(),
        filename: status.file.filename.clone(),
        media_type: status.file.media_type.clone(),
        byte_length: total,
    };
    let receipt=MessageAttachmentReceipt{manifest_id:Some(status.file.upload_id),note:format!("[File attached in the Orkestr app, encrypted upload {}: {} ({}, {} bytes), SHA-256 {}, local file {}]",status.file.upload_id,status.file.filename,status.file.media_type,total,digest,path.display()),attachments:vec![summary]};
    ingest.prepared.remember(status, &file, receipt.clone());
    Ok(receipt)
}

fn publish_prepared(
    file: &std::fs::File,
    dir: &std::fs::File,
    temporary: &str,
    name: &str,
    gid: Option<u32>,
) -> Result<(), orkestr_v2_store_sqlite::attachment_store::AttachmentError> {
    use orkestr_v2_store_sqlite::attachment_store::AttachmentError;
    let mut renamed = false;
    let result = (|| {
        if let Some(gid) = gid {
            rustix::fs::fchown(file, None, Some(rustix::process::Gid::from_raw(gid)))?;
        }
        rustix::fs::fchmod(file, rustix::fs::Mode::from_raw_mode(0o640))?;
        rustix::fs::renameat(dir, temporary, dir, name)?;
        renamed = true;
        dir.sync_all().map_err(|_| rustix::io::Errno::IO)
    })();
    if result.is_err() {
        let _ = rustix::fs::fchmod(file, rustix::fs::Mode::from_raw_mode(0o600));
        if renamed && rustix::fs::unlinkat(dir, name, rustix::fs::AtFlags::empty()).is_err() {
            eprintln!("encrypted upload publication cleanup requires operator reconciliation");
        }
        let _ = dir.sync_all();
        return Err(AttachmentError::Unavailable);
    }
    Ok(())
}

fn export_name(status: &EncryptedUploadStatus) -> String {
    format!(
        "{}{}",
        status.file.upload_id,
        crate::message_attachments::extension(&status.file.media_type, &status.file.filename)
    )
}
pub(crate) fn remove_export(
    state: &AppState,
    status: &EncryptedUploadStatus,
) -> Result<(), &'static str> {
    let Some(export) = state.attachment_export.as_ref() else {
        return Ok(());
    };
    let folder = export.dir.join(status.conversation_id.to_string());
    if !folder.exists() {
        return Ok(());
    }
    let dir = private_fs::directory(&folder, false)?;
    match rustix::fs::unlinkat(&dir, export_name(status), rustix::fs::AtFlags::empty()) {
        Ok(()) => {}
        Err(rustix::io::Errno::NOENT) => {}
        Err(_) => return Err("provider export removal failed"),
    }
    dir.sync_all()
        .map_err(|_| "provider export removal sync failed")?;
    if let Some(ingest) = state.attachment_ingest.as_ref() {
        ingest.prepared.forget(status.file.upload_id);
    }
    Ok(())
}
