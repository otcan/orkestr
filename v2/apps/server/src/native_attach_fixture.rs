//! Test only: a private hold directory owned by this test process, written
//! the way the root CLI writes it (read-only records, one link).
use super::NativeAttachHolds;
use orkestr_v2_contracts::ConversationId;
use std::{
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

pub(crate) struct Holds {
    pub root: PathBuf,
    pub dir: PathBuf,
    pub holds: Arc<NativeAttachHolds>,
}

impl Holds {
    pub(crate) fn new() -> Self {
        let root = std::env::temp_dir().join(format!("native-attach-{}", Uuid::new_v4()));
        let dir = root.join("records");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o750)).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o750)).unwrap();
        let uid = std::fs::metadata(&dir).unwrap().uid();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let holds = Arc::new(
            NativeAttachHolds::bind_owned(&dir, Path::new("/synthetic-core-home"), uid).unwrap(),
        );
        Self { root, dir, holds }
    }

    /// A fresh binding of the same directory, as a restarted server has.
    pub(crate) fn rebind(&self) -> Arc<NativeAttachHolds> {
        let uid = std::fs::metadata(&self.dir).unwrap().uid();
        Arc::new(
            NativeAttachHolds::bind_owned(&self.dir, Path::new("/synthetic-core-home"), uid)
                .unwrap(),
        )
    }

    pub(crate) fn write(&self, name: &str, value: &serde_json::Value, mode: u32) {
        let path = self.dir.join(name);
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// The record the CLI writes for an attach acquired at `now_ms`.
    pub(crate) fn record(conversation: &ConversationId, now_ms: i64) -> serde_json::Value {
        serde_json::json!({
            "format": "orkestr-native-attach-hold-v1",
            "conversation_id": conversation,
            "session_id": Uuid::from_u128(0x5e55_1011),
            "native_session_id": Uuid::from_u128(0xa71e),
            "provider": "codex",
            "binding_generation": 17,
            "holder_pid": 4242,
            "acquired_at_ms": now_ms - 1_000,
            "renewed_at_ms": now_ms,
            "expires_at_ms": now_ms + 120_000,
        })
    }

    /// An active hold of `conversation` from now on.
    pub(crate) fn hold(&self, conversation: &ConversationId) {
        let now = crate::deploy_drain::now_ms();
        self.write(
            &format!("{}.json", conversation.0),
            &Self::record(conversation, now),
            0o440,
        );
    }

    /// The CLI's release: the hold record is gone.
    pub(crate) fn release(&self, conversation: &ConversationId) {
        std::fs::remove_file(self.dir.join(format!("{}.json", conversation.0))).unwrap();
    }

    /// The ended record of an attach to `native` between the two instants.
    pub(crate) fn ended(
        &self,
        conversation: &ConversationId,
        native: Uuid,
        started: i64,
        ended: i64,
    ) {
        self.write(
            &format!("{}.ended.json", conversation.0),
            &serde_json::json!({
                "format": "orkestr-native-attach-ended-v1",
                "conversation_id": conversation,
                "native_session_id": native,
                "started_at_ms": started,
                "ended_at_ms": ended,
                "reason": "terminal_exit",
            }),
            0o440,
        );
    }
}

impl Drop for Holds {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
