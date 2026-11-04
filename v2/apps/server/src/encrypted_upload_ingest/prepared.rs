//! Serialize retries of one upload and reuse only unchanged verified exports.
//! Entries are bounded; a changed/missing file always takes the full path.
use super::*;
use std::os::unix::fs::MetadataExt;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};
type Gate = tokio::sync::Mutex<()>;
#[derive(Clone)]
struct Entry {
    signature: String,
    stamp: (u64, u64, u64, i64, i64),
    receipt: MessageAttachmentReceipt,
}
#[derive(Default)]
pub(super) struct Prepared {
    jobs: Mutex<BTreeMap<Uuid, Weak<Gate>>>,
    entries: Mutex<BTreeMap<Uuid, Entry>>,
}
fn signature(status: &EncryptedUploadStatus) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(status).unwrap()))
}
fn stamp(file: &std::fs::File) -> Option<(u64, u64, u64, i64, i64)> {
    let m = file.metadata().ok()?;
    if !m.is_file() || m.nlink() != 1 {
        return None;
    }
    Some((m.dev(), m.ino(), m.len(), m.mtime(), m.mtime_nsec()))
}
impl Prepared {
    pub async fn acquire(&self, id: Uuid) -> tokio::sync::OwnedMutexGuard<()> {
        let gate = {
            let mut jobs = self.jobs.lock().unwrap();
            jobs.retain(|_, v| v.strong_count() > 0);
            if let Some(gate) = jobs.get(&id).and_then(Weak::upgrade) {
                gate
            } else {
                let gate = Arc::new(Gate::new(()));
                jobs.insert(id, Arc::downgrade(&gate));
                gate
            }
        };
        gate.lock_owned().await
    }
    pub fn cached(
        &self,
        status: &EncryptedUploadStatus,
        dir: &std::fs::File,
        name: &str,
    ) -> Option<MessageAttachmentReceipt> {
        let entry = self
            .entries
            .lock()
            .unwrap()
            .get(&status.file.upload_id)?
            .clone();
        if entry.signature != signature(status) {
            return None;
        }
        let file: std::fs::File = rustix::fs::openat(
            dir,
            name,
            rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .ok()?
        .into();
        (stamp(&file)? == entry.stamp).then_some(entry.receipt)
    }
    pub fn remember(
        &self,
        status: &EncryptedUploadStatus,
        file: &std::fs::File,
        receipt: MessageAttachmentReceipt,
    ) {
        if let Some(stamp) = stamp(file) {
            let mut entries = self.entries.lock().unwrap();
            if entries.len() >= 128 {
                entries.pop_first();
            }
            entries.insert(
                status.file.upload_id,
                Entry {
                    signature: signature(status),
                    stamp,
                    receipt,
                },
            );
        }
    }
    pub fn forget(&self, id: Uuid) {
        self.entries.lock().unwrap().remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn duplicate_jobs_serialize_and_cancelled_waiters_do_not_block_retries() {
        let prepared = Arc::new(Prepared::default());
        let id = Uuid::new_v4();
        let first = prepared.acquire(id).await;
        let p = prepared.clone();
        let waiting = tokio::spawn(async move { p.acquire(id).await });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        let other = prepared.acquire(Uuid::new_v4()).await;
        drop(other);
        waiting.abort();
        assert!(waiting.await.unwrap_err().is_cancelled());
        drop(first);
        let _retry = tokio::time::timeout(std::time::Duration::from_secs(1), prepared.acquire(id))
            .await
            .unwrap();
    }
}
