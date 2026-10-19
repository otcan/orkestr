//! Independent actual Store copy roundtrip. Synthetic data only; no HTTP claim.
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::{Store, attachment_store::AttachmentError as E};
use std::path::{Path, PathBuf};
use uuid::Uuid;
fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}
fn vectors() -> Vec<Vec<u8>> {
    vec![
        vec![],
        vec![0, 255, 128, 10, 13, 0],
        b"same\r\nbytes\n".to_vec(),
        b"same\r\nbytes\n".to_vec(),
    ]
}
async fn fresh() -> (Store, OwnerId, ConversationId, PathBuf) {
    let dir = std::env::temp_dir().join(format!("independent-attachment-{}", Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let store = Store::open(&dir.join("store.sqlite3")).await.unwrap();
    store
        .setup("fake-owner", "fake-password-hash")
        .await
        .unwrap();
    let owner = store.credentials("fake-owner").await.unwrap().unwrap().0;
    store
        .save_session("fake-current-session", &owner)
        .await
        .unwrap();
    let conversation = store.global(&owner).await.unwrap();
    (store, owner, conversation, dir)
}
fn bundle() -> AttachmentBundle {
    let mut manifest: AttachmentManifest =
        serde_json::from_str(include_str!("attachment-cases.json")).unwrap();
    let contents = manifest
        .references
        .iter()
        .zip(vectors())
        .map(|(r, bytes)| AttachmentContent {
            reference_id: r.reference_id,
            bytes,
        })
        .collect();
    let mut removed = manifest.references[0].clone();
    removed.reference_id = id(80);
    removed.state = AttachmentState::Removed;
    let mut inert = removed.clone();
    inert.reference_id = id(81);
    inert.state = AttachmentState::Inert;
    inert.filename = "opaque/legacy/path".into();
    inert.byte_length = 32 * 1024 * 1024;
    inert.sha256 = "unknown legacy digest".into();
    manifest.references.extend([removed, inert]);
    AttachmentBundle { manifest, contents }
}
fn request(
    source: AttachmentBundle,
    o: &OwnerId,
    c: &ConversationId,
    base: u128,
) -> AttachmentImportRequest {
    let mut target = source.manifest.clone();
    target.manifest_id = id(base);
    target.owner_id = o.clone();
    target.conversation_id = c.clone();
    for (i, r) in target.references.iter_mut().enumerate() {
        r.reference_id = id(base + 10 + i as u128);
        r.message_id = None;
    }
    let mapping = source
        .manifest
        .references
        .iter()
        .zip(&target.references)
        .map(|(a, b)| AttachmentReferenceMapping {
            source_reference_id: a.reference_id,
            target_reference_id: b.reference_id,
        })
        .collect();
    AttachmentImportRequest {
        request_key: format!("fake-copy-{base}"),
        source,
        target_manifest: target,
        mapping,
    }
}
async fn native_rows(path: &Path) -> Vec<i64> {
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}?mode=ro", path.display()))
        .await
        .unwrap();
    let mut counts = vec![];
    for table in ["messages", "events", "reasoning_inbox", "outbox"] {
        counts.push(
            sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap(),
        );
    }
    pool.close().await;
    counts
}
async fn provenance(path: &Path, manifest: Uuid) -> AttachmentManifest {
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}?mode=ro", path.display()))
        .await
        .unwrap();
    let raw: String = sqlx::query_scalar(
        "SELECT source_manifest_json FROM attachment_imports WHERE manifest_id=?",
    )
    .bind(manifest.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    pool.close().await;
    serde_json::from_str(&raw).unwrap()
}
#[tokio::test]
async fn real_export_fresh_import_reopen_exact_bytes_provenance_and_no_admission() {
    let (a, ao, ac, ad) = fresh().await;
    let before_a = native_rows(&ad.join("store.sqlite3")).await;
    let original = bundle();
    let req = request(original.clone(), &ao, &ac, 100);
    let receipt = a
        .import_attachment_bundle_authenticated("fake-current-session", &ao, &ac, &req)
        .await
        .unwrap();
    assert_eq!(receipt.source_manifest_id, original.manifest.manifest_id);
    assert_eq!(receipt.manifest, req.target_manifest);
    assert_eq!(receipt.mapping, req.mapping);
    assert_eq!(
        provenance(&ad.join("store.sqlite3"), req.target_manifest.manifest_id).await,
        original.manifest
    );
    let exported = a
        .export_attachment_bundle_authenticated(
            "fake-current-session",
            &ao,
            &ac,
            req.target_manifest.manifest_id,
        )
        .await
        .unwrap();
    let (b, bo, bc, bd) = fresh().await;
    let before_b = native_rows(&bd.join("store.sqlite3")).await;
    let copy = request(exported.clone(), &bo, &bc, 200);
    let initial = b
        .import_attachment_bundle_authenticated("fake-current-session", &bo, &bc, &copy)
        .await
        .unwrap();
    b.close().await;
    let b = Store::open(&bd.join("store.sqlite3")).await.unwrap();
    let current = b
        .export_attachment_bundle_authenticated(
            "fake-current-session",
            &bo,
            &bc,
            copy.target_manifest.manifest_id,
        )
        .await
        .unwrap();
    assert_eq!(current.manifest, copy.target_manifest);
    assert_eq!(current.contents.len(), 4);
    assert_eq!(
        provenance(&bd.join("store.sqlite3"), copy.target_manifest.manifest_id).await,
        exported.manifest
    );
    for (i, expected) in vectors().iter().enumerate() {
        let reference = copy.target_manifest.references[i].reference_id;
        let (metadata, actual) = b
            .download_attachment_authenticated(
                "fake-current-session",
                &bo,
                &bc,
                copy.target_manifest.manifest_id,
                reference,
            )
            .await
            .unwrap();
        assert_eq!(&actual, expected);
        assert_eq!(metadata, copy.target_manifest.references[i]);
        assert_eq!(
            &current
                .contents
                .iter()
                .find(|x| x.reference_id == reference)
                .unwrap()
                .bytes,
            expected
        );
    }
    for (index, error) in [(4, E::Removed), (5, E::Inert)] {
        assert_eq!(
            b.download_attachment_authenticated(
                "fake-current-session",
                &bo,
                &bc,
                copy.target_manifest.manifest_id,
                copy.target_manifest.references[index].reference_id
            )
            .await
            .err(),
            Some(error)
        );
    }
    let reference = copy.target_manifest.references[1].reference_id;
    b.remove_attachment_authenticated(
        "fake-current-session",
        &bo,
        &bc,
        copy.target_manifest.manifest_id,
        reference,
        "fake-remove",
    )
    .await
    .unwrap();
    assert_eq!(
        b.import_attachment_bundle_authenticated("fake-current-session", &bo, &bc, &copy)
            .await
            .unwrap(),
        initial
    );
    assert_eq!(
        b.download_attachment_authenticated(
            "fake-current-session",
            &bo,
            &bc,
            copy.target_manifest.manifest_id,
            reference
        )
        .await
        .err(),
        Some(E::Removed)
    );
    let cut = b
        .export_attachment_bundle_authenticated(
            "fake-current-session",
            &bo,
            &bc,
            copy.target_manifest.manifest_id,
        )
        .await
        .unwrap();
    assert_eq!(cut.contents.len(), 3);
    assert_eq!(cut.manifest.references[1].state, AttachmentState::Removed);
    assert_eq!(native_rows(&ad.join("store.sqlite3")).await, before_a);
    assert_eq!(native_rows(&bd.join("store.sqlite3")).await, before_b);
    // Export source provenance retains original message identities; target remains unbound.
    assert!(
        original.manifest.references[..4]
            .iter()
            .all(|r| r.message_id.is_some())
    );
    assert!(
        current
            .manifest
            .references
            .iter()
            .all(|r| r.message_id.is_none())
    );
    b.revoke_session("fake-current-session").await.unwrap();
    assert_eq!(
        b.import_attachment_bundle_authenticated("fake-current-session", &bo, &bc, &copy)
            .await
            .err(),
        Some(E::Unauthorized)
    );
    a.close().await;
    b.close().await;
    std::fs::remove_dir_all(ad).unwrap();
    std::fs::remove_dir_all(bd).unwrap();
}
#[tokio::test]
async fn real_refusals_leave_no_partial_target_and_changed_replay_conflicts() {
    let (s, o, c, d) = fresh().await;
    let good = request(bundle(), &o, &c, 300);
    for mode in 0..5 {
        let mut bad = good.clone();
        match mode {
            0 => bad.source.contents[1].bytes[0] ^= 1,
            1 => {
                bad.source.contents.pop();
            }
            2 => bad.mapping[1] = bad.mapping[0].clone(),
            3 => bad.source.contents[1].bytes.push(0),
            _ => bad.target_manifest.references[0].message_id = Some(MessageId(id(999))),
        }
        assert_eq!(
            s.import_attachment_bundle_authenticated("fake-current-session", &o, &c, &bad)
                .await
                .err(),
            Some(E::Invalid)
        );
        assert_eq!(
            s.attachment_manifest_authenticated(
                "fake-current-session",
                &o,
                &c,
                good.target_manifest.manifest_id
            )
            .await
            .err(),
            Some(E::NotFound)
        );
    }
    s.import_attachment_bundle_authenticated("fake-current-session", &o, &c, &good)
        .await
        .unwrap();
    let mut changed = good.clone();
    changed.source.contents.reverse();
    assert_eq!(
        s.import_attachment_bundle_authenticated("fake-current-session", &o, &c, &changed)
            .await
            .err(),
        Some(E::Conflict)
    );
    assert_eq!(
        s.download_attachment_authenticated(
            "fake-current-session",
            &o,
            &ConversationId(id(999)),
            good.target_manifest.manifest_id,
            good.target_manifest.references[0].reference_id
        )
        .await
        .err(),
        Some(E::NotFound)
    );
    assert_eq!(
        s.download_attachment_authenticated(
            "fake-current-session",
            &OwnerId(id(999)),
            &c,
            good.target_manifest.manifest_id,
            good.target_manifest.references[0].reference_id
        )
        .await
        .err(),
        Some(E::Unauthorized)
    );
    s.close().await;
    std::fs::remove_dir_all(d).unwrap();
}
