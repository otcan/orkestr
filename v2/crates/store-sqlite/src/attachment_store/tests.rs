use super::*;
use sha2::{Digest, Sha256};
pub(super) async fn fixture() -> (Store, OwnerId, ConversationId, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("attachment-test-{}", Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let store = Store::open(&dir.join("store.sqlite3")).await.unwrap();
    store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    store.save_session("synthetic-token", &owner).await.unwrap();
    let conversation = store.global(&owner).await.unwrap();
    (store, owner, conversation, dir)
}
pub(super) fn request(owner: &OwnerId, conversation: &ConversationId) -> AttachmentImportRequest {
    let mut m = AttachmentManifest {
        schema_version: 1,
        manifest_id: Uuid::new_v4(),
        owner_id: OwnerId(Uuid::new_v4()),
        conversation_id: ConversationId(Uuid::new_v4()),
        references: Vec::new(),
    };
    let bytes = b"synthetic\0binary\r\n".to_vec();
    let id = Uuid::new_v4();
    m.references.push(AttachmentReference {
        reference_id: id,
        message_id: None,
        filename: "sample.bin".into(),
        media_type: "application/octet-stream".into(),
        byte_length: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        state: AttachmentState::Available,
    });
    let mut target = m.clone();
    target.manifest_id = Uuid::new_v4();
    target.owner_id = owner.clone();
    target.conversation_id = conversation.clone();
    target.references[0].reference_id = Uuid::new_v4();
    AttachmentImportRequest {
        request_key: "synthetic-import".into(),
        mapping: vec![AttachmentReferenceMapping {
            source_reference_id: id,
            target_reference_id: target.references[0].reference_id,
        }],
        source: AttachmentBundle {
            manifest: m,
            contents: vec![AttachmentContent {
                reference_id: id,
                bytes,
            }],
        },
        target_manifest: target,
    }
}
pub(super) async fn audit(s: &Store) -> Vec<(String, Vec<String>)> {
    let mut result = Vec::new();
    for table in [
        "attachment_manifests",
        "attachment_objects",
        "attachment_imports",
        "attachment_removals",
        "messages",
        "events",
        "reasoning_inbox",
        "outbox",
        "conversations",
    ] {
        let columns: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT name FROM pragma_table_info('{table}') ORDER BY cid"
        ))
        .fetch_all(&s.pool)
        .await
        .unwrap();
        let expr = columns
            .iter()
            .map(|c| format!("quote(\"{c}\")"))
            .collect::<Vec<_>>()
            .join("||'|'||");
        let rows = sqlx::query_scalar(&format!("SELECT {expr} AS row FROM {table} ORDER BY row"))
            .fetch_all(&s.pool)
            .await
            .unwrap();
        result.push((table.into(), rows));
    }
    result
}
#[tokio::test]
async fn persisted_roundtrip_reopen_replay_removal_does_not_resurrect() {
    let (s, o, c, d) = fixture().await;
    let r = request(&o, &c);
    let receipt = s
        .import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
        .await
        .unwrap();
    let id = r.target_manifest.manifest_id;
    let reference = r.target_manifest.references[0].reference_id;
    let (_, bytes) = s
        .download_attachment_authenticated("synthetic-token", &o, &c, id, reference)
        .await
        .unwrap();
    assert_eq!(bytes, r.source.contents[0].bytes);
    let b = s
        .export_attachment_bundle_authenticated("synthetic-token", &o, &c, id)
        .await
        .unwrap();
    assert_eq!(b.manifest, r.target_manifest);
    assert_eq!(b.contents[0].bytes, bytes);
    let before = audit(&s).await;
    s.close().await;
    let s = Store::open(&d.join("store.sqlite3")).await.unwrap();
    assert_eq!(
        s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(audit(&s).await, before);
    let removal = s
        .remove_attachment_authenticated("synthetic-token", &o, &c, id, reference, "remove")
        .await
        .unwrap();
    let after = audit(&s).await;
    assert_eq!(
        s.remove_attachment_authenticated("synthetic-token", &o, &c, id, reference, "remove")
            .await
            .unwrap(),
        removal
    );
    assert_eq!(
        s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(audit(&s).await, after);
    assert_eq!(
        s.download_attachment_authenticated("synthetic-token", &o, &c, id, reference)
            .await
            .err(),
        Some(AttachmentError::Removed)
    );
    let b = s
        .export_attachment_bundle_authenticated("synthetic-token", &o, &c, id)
        .await
        .unwrap();
    assert!(b.contents.is_empty());
    assert_eq!(b.manifest.references[0].state, AttachmentState::Removed);
    assert_eq!(
        b.manifest.references[0].sha256,
        r.target_manifest.references[0].sha256
    );
    s.close().await;
    std::fs::remove_dir_all(d).unwrap();
}
#[tokio::test]
async fn refusal_and_current_session_before_historical_receipt() {
    let (s, o, c, d) = fixture().await;
    let r = request(&o, &c);
    s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
        .await
        .unwrap();
    let before = audit(&s).await;
    let mut bad = r.clone();
    bad.request_key = "bad".into();
    bad.source.contents[0].bytes[0] ^= 1;
    assert_eq!(
        s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &bad)
            .await
            .err(),
        Some(AttachmentError::Invalid)
    );
    bad = r.clone();
    bad.mapping.clear();
    assert_eq!(
        s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &bad)
            .await
            .err(),
        Some(AttachmentError::Invalid)
    );
    bad = r.clone();
    bad.target_manifest.references[0].filename = "changed.bin".into();
    bad.source.manifest.references[0].filename = "changed.bin".into();
    assert_eq!(
        s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &bad)
            .await
            .err(),
        Some(AttachmentError::Conflict)
    );
    assert_eq!(
        s.download_attachment_authenticated(
            "synthetic-token",
            &o,
            &ConversationId(Uuid::new_v4()),
            r.target_manifest.manifest_id,
            r.target_manifest.references[0].reference_id
        )
        .await
        .err(),
        Some(AttachmentError::NotFound)
    );
    s.revoke_session("synthetic-token").await.unwrap();
    assert_eq!(
        s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
            .await
            .err(),
        Some(AttachmentError::Unauthorized)
    );
    assert_eq!(
        s.export_attachment_bundle_authenticated(
            "synthetic-token",
            &o,
            &c,
            r.target_manifest.manifest_id
        )
        .await
        .err(),
        Some(AttachmentError::Unauthorized)
    );
    assert_eq!(audit(&s).await, before);
    s.close().await;
    std::fs::remove_dir_all(d).unwrap();
}
#[tokio::test]
async fn inert_legacy_and_empty_available_survive_copy() {
    let (s, o, c, d) = fixture().await;
    let mut r = request(&o, &c);
    r.source.contents.clear();
    for m in [&mut r.source.manifest, &mut r.target_manifest] {
        m.references[0].state = AttachmentState::Inert;
        m.references[0].byte_length = ATTACHMENT_MAX_BYTES + 1;
        m.references[0].filename = "legacy/opaque".into();
        m.references[0].sha256 = String::new();
    }
    s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
        .await
        .unwrap();
    let b = s
        .export_attachment_bundle_authenticated(
            "synthetic-token",
            &o,
            &c,
            r.target_manifest.manifest_id,
        )
        .await
        .unwrap();
    assert_eq!(b.manifest, r.target_manifest);
    assert!(b.contents.is_empty());
    assert_eq!(
        s.download_attachment_authenticated(
            "synthetic-token",
            &o,
            &c,
            b.manifest.manifest_id,
            b.manifest.references[0].reference_id
        )
        .await
        .err(),
        Some(AttachmentError::Inert)
    );
    let mut r = request(&o, &c);
    r.request_key = "empty".into();
    r.source.contents[0].bytes.clear();
    for m in [&mut r.source.manifest, &mut r.target_manifest] {
        m.references[0].byte_length = 0;
        m.references[0].sha256 = format!("{:x}", Sha256::digest([]));
    }
    s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
        .await
        .unwrap();
    assert!(s
        .download_attachment_authenticated(
            "synthetic-token",
            &o,
            &c,
            r.target_manifest.manifest_id,
            r.target_manifest.references[0].reference_id
        )
        .await
        .unwrap()
        .1
        .is_empty());
    s.close().await;
    std::fs::remove_dir_all(d).unwrap();
}
#[tokio::test]
async fn two_pool_same_key_has_one_import_and_atomic_insert_failure() {
    let (s, o, c, d) = fixture().await;
    let other = Store::open(&d.join("store.sqlite3")).await.unwrap();
    let r = request(&o, &c);
    let (a, b) = tokio::join!(
        s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r),
        other.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
    );
    assert_eq!(a.unwrap(), b.unwrap());
    let mut r = request(&o, &c);
    r.request_key = "rollback".into();
    let before = audit(&s).await;
    sqlx::query("CREATE TRIGGER attachment_abort BEFORE INSERT ON attachment_imports BEGIN SELECT RAISE(ABORT,'synthetic'); END").execute(&s.pool).await.unwrap();
    assert_eq!(
        s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
            .await
            .err(),
        Some(AttachmentError::Unavailable)
    );
    assert_eq!(audit(&s).await, before);
    sqlx::query("DROP TRIGGER attachment_abort")
        .execute(&s.pool)
        .await
        .unwrap();
    s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
        .await
        .unwrap();
    other.close().await;
    s.close().await;
    std::fs::remove_dir_all(d).unwrap();
}

#[tokio::test]
async fn stored_corruption_refuses_bytes_and_removal_replay_requires_current_auth() {
    let (s, o, c, d) = fixture().await;
    let r = request(&o, &c);
    s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
        .await
        .unwrap();
    let m = r.target_manifest.manifest_id;
    let id = r.target_manifest.references[0].reference_id;
    sqlx::query("UPDATE attachment_objects SET bytes=? WHERE reference_id=?")
        .bind(vec![0u8; r.source.contents[0].bytes.len()])
        .bind(id.to_string())
        .execute(&s.pool)
        .await
        .unwrap();
    let before = audit(&s).await;
    assert_eq!(
        s.download_attachment_authenticated("synthetic-token", &o, &c, m, id)
            .await
            .err(),
        Some(AttachmentError::Unavailable)
    );
    assert_eq!(
        s.export_attachment_bundle_authenticated("synthetic-token", &o, &c, m)
            .await
            .err(),
        Some(AttachmentError::Unavailable)
    );
    assert_eq!(audit(&s).await, before);
    s.remove_attachment_authenticated("synthetic-token", &o, &c, m, id, "remove")
        .await
        .unwrap();
    let before = audit(&s).await;
    s.revoke_session("synthetic-token").await.unwrap();
    assert_eq!(
        s.remove_attachment_authenticated("synthetic-token", &o, &c, m, id, "remove")
            .await
            .err(),
        Some(AttachmentError::Unauthorized)
    );
    assert_eq!(audit(&s).await, before);
    s.close().await;
    std::fs::remove_dir_all(d).unwrap();
}
