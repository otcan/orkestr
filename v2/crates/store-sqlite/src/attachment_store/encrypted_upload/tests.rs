use super::*;
use crate::attachment_store::{keys::ImportedRecipient, seal::testing::identity, tests::fixture};
const TOKEN: &str = "synthetic-token";

#[tokio::test]
async fn metadata_receipts_use_the_small_covering_index_instead_of_blob_pages() {
    use sqlx::Row;
    let (s, _o, _c, _d, file, _key) = setup(3).await;
    let rows=sqlx::query("EXPLAIN QUERY PLAN SELECT chunk_index,length(ciphertext) AS size,ciphertext_sha256 FROM encrypted_upload_chunks WHERE upload_id=? ORDER BY chunk_index")
        .bind(file.upload_id.to_string()).fetch_all(&s.pool).await.unwrap();
    assert!(rows.iter().any(|r| r
        .get::<String, _>("detail")
        .contains("encrypted_upload_receipt_cover")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publication_lease_serializes_revocation_at_final_rename_boundary() {
    use std::sync::{Arc, Barrier};
    let (s, o, c, _d, file, key) = setup(3).await;
    s.encrypted_upload_start(TOKEN, &o, &c, &file)
        .await
        .unwrap();
    let bytes = seal::encrypt(&[key], b"abc").unwrap();
    let chunk = s
        .encrypted_upload_put(
            TOKEN,
            &o,
            &c,
            file.upload_id,
            0,
            &seal::sha256_hex(&bytes),
            &bytes,
        )
        .await
        .unwrap();
    let status = s
        .encrypted_upload_finish(TOKEN, &o, &c, file.upload_id, &[chunk])
        .await
        .unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let gate = barrier.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let publisher = s.clone();
    let (po, pc, ps) = (o.clone(), c.clone(), status.clone());
    let publish = tokio::spawn(async move {
        publisher
            .encrypted_upload_publish(TOKEN, &po, &pc, &ps, || {
                entered.send(()).unwrap();
                gate.wait();
                Ok(())
            })
            .await
    });
    ready.await.unwrap();
    let revoker = s.clone();
    let revoke = tokio::spawn(async move { revoker.revoke_session(TOKEN).await });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(
        !revoke.is_finished(),
        "revocation cannot commit inside publication lease"
    );
    tokio::task::spawn_blocking(move || {
        barrier.wait();
    })
    .await
    .unwrap();
    publish.await.unwrap().unwrap();
    revoke.await.unwrap().unwrap();
    assert_eq!(
        s.encrypted_upload_publish(TOKEN, &o, &c, &status, || panic!(
            "revoked session published"
        ))
        .await,
        Err(AttachmentError::Unauthorized)
    );
}

#[tokio::test]
async fn completed_objects_remain_charged_to_reserved_owner_storage_quota() {
    let (s, o, c, _d, mut file, _key) = setup(ENCRYPTED_UPLOAD_MAX_BYTES).await;
    for _ in 0..4 {
        file.upload_id = Uuid::new_v4();
        s.encrypted_upload_start(TOKEN, &o, &c, &file)
            .await
            .unwrap();
        sqlx::query("UPDATE encrypted_uploads SET complete=1 WHERE id=?")
            .bind(file.upload_id.to_string())
            .execute(&s.pool)
            .await
            .unwrap();
    }
    let saved = file.upload_id;
    file.upload_id = Uuid::new_v4();
    assert_eq!(
        s.encrypted_upload_start(TOKEN, &o, &c, &file).await,
        Err(AttachmentError::Conflict)
    );
    s.encrypted_upload_remove(TOKEN, &o, &c, saved)
        .await
        .unwrap();
    assert!(s.encrypted_upload_start(TOKEN, &o, &c, &file).await.is_ok());
}

async fn setup(
    size: u64,
) -> (
    Store,
    OwnerId,
    ConversationId,
    std::path::PathBuf,
    EncryptedUploadStart,
    String,
) {
    let (s, o, c, d) = fixture().await;
    let (_, recipient) = identity();
    s.import_attachment_recipients(
        &o,
        &[ImportedRecipient {
            recipient: recipient.clone(),
            label: "Synthetic browser".into(),
            verified_at: 1,
        }],
    )
    .await
    .unwrap();
    let file = EncryptedUploadStart {
        upload_id: Uuid::new_v4(),
        filename: "sample.bin".into(),
        media_type: "application/octet-stream".into(),
        plaintext_size: size,
    };
    (s, o, c, d, file, recipient)
}

#[tokio::test]
async fn interrupted_upload_reopens_retries_finishes_and_never_stores_plaintext() {
    let (s, o, c, d, file, key) = setup(ENCRYPTED_UPLOAD_CHUNK_BYTES + 3).await;
    let initial = s
        .encrypted_upload_start(TOKEN, &o, &c, &file)
        .await
        .unwrap();
    assert_eq!(initial.recipients, vec![key.clone()]);
    let first = seal::encrypt(
        std::slice::from_ref(&key),
        &vec![42; ENCRYPTED_UPLOAD_CHUNK_BYTES as usize],
    )
    .unwrap();
    let digest = seal::sha256_hex(&first);
    let receipt = s
        .encrypted_upload_put(TOKEN, &o, &c, file.upload_id, 0, &digest, &first)
        .await
        .unwrap();
    assert_eq!(
        s.encrypted_upload_put(TOKEN, &o, &c, file.upload_id, 0, &digest, &first)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        s.encrypted_upload_finish(
            TOKEN,
            &o,
            &c,
            file.upload_id,
            std::slice::from_ref(&receipt)
        )
        .await,
        Err(AttachmentError::Conflict)
    );
    s.pool.close().await;
    let s = Store::open(&d.join("store.sqlite3")).await.unwrap();
    let resumed = s
        .encrypted_upload_start(TOKEN, &o, &c, &file)
        .await
        .unwrap();
    assert_eq!(resumed.chunks, vec![receipt.clone()]);
    let last = seal::encrypt(&[key], b"end").unwrap();
    let r2 = s
        .encrypted_upload_put(
            TOKEN,
            &o,
            &c,
            file.upload_id,
            1,
            &seal::sha256_hex(&last),
            &last,
        )
        .await
        .unwrap();
    let mut wrong = vec![r2.clone(), receipt.clone()];
    assert_eq!(
        s.encrypted_upload_finish(TOKEN, &o, &c, file.upload_id, &wrong)
            .await,
        Err(AttachmentError::Conflict)
    );
    wrong.reverse();
    assert!(
        s.encrypted_upload_finish(TOKEN, &o, &c, file.upload_id, &wrong)
            .await
            .unwrap()
            .complete
    );
    assert!(
        s.encrypted_upload_finish(TOKEN, &o, &c, file.upload_id, &wrong)
            .await
            .unwrap()
            .complete
    );
    assert_eq!(
        s.encrypted_upload_chunk(TOKEN, &o, &c, file.upload_id, 0)
            .await
            .unwrap(),
        first
    );
    // Existing plaintext attachment/message paths are untouched by ciphertext storage.
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM attachment_objects")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    s.encrypted_upload_remove(TOKEN, &o, &c, file.upload_id)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM encrypted_upload_chunks")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn scope_corruption_expiration_and_size_are_fail_closed() {
    let (s, o, c, _d, mut file, key) = setup(3).await;
    s.encrypted_upload_start(TOKEN, &o, &c, &file)
        .await
        .unwrap();
    let ciphertext = seal::encrypt(&[key], b"abc").unwrap();
    let digest = seal::sha256_hex(&ciphertext);
    assert_eq!(
        s.encrypted_upload_put(TOKEN, &o, &c, file.upload_id, 0, &digest, b"abc")
            .await,
        Err(AttachmentError::Invalid)
    );
    assert_eq!(
        s.encrypted_upload_put(TOKEN, &o, &c, file.upload_id, 1, &digest, &ciphertext)
            .await,
        Err(AttachmentError::Invalid)
    );
    let mut bad = ciphertext.clone();
    bad[40] ^= 1;
    assert_eq!(
        s.encrypted_upload_put(TOKEN, &o, &c, file.upload_id, 0, &digest, &bad)
            .await,
        Err(AttachmentError::Invalid)
    );
    let oversized = vec![0; ENCRYPTED_UPLOAD_CIPHERTEXT_MAX + 1];
    assert_eq!(
        s.encrypted_upload_put(TOKEN, &o, &c, file.upload_id, 0, "", &oversized)
            .await,
        Err(AttachmentError::Invalid)
    );
    s.encrypted_upload_put(TOKEN, &o, &c, file.upload_id, 0, &digest, &ciphertext)
        .await
        .unwrap();
    assert_eq!(
        s.encrypted_upload_put("revoked", &o, &c, file.upload_id, 0, &digest, &ciphertext)
            .await,
        Err(AttachmentError::Unauthorized)
    );
    let other = s
        .create_conversation_authenticated(
            TOKEN,
            &ConversationInput {
                client_request_id: "synthetic-other".into(),
                name: "Other".into(),
            },
        )
        .await
        .unwrap()
        .0
        .conversation_id;
    assert_eq!(
        s.encrypted_upload_status(TOKEN, &o, &other, file.upload_id)
            .await,
        Err(AttachmentError::NotFound)
    );
    let owner2 = OwnerId(Uuid::new_v4());
    assert_eq!(
        s.encrypted_upload_status(TOKEN, &owner2, &c, file.upload_id)
            .await,
        Err(AttachmentError::Unauthorized)
    );
    sqlx::query("UPDATE encrypted_upload_chunks SET ciphertext=? WHERE upload_id=?")
        .bind(&bad)
        .bind(file.upload_id.to_string())
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        s.encrypted_upload_chunk(TOKEN, &o, &c, file.upload_id, 0)
            .await,
        Err(AttachmentError::Unavailable)
    );
    sqlx::query("UPDATE encrypted_uploads SET created_at=0 WHERE id=?")
        .bind(file.upload_id.to_string())
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        s.encrypted_upload_status(TOKEN, &o, &c, file.upload_id)
            .await,
        Err(AttachmentError::NotFound)
    );
    file.upload_id = Uuid::new_v4();
    file.plaintext_size = ENCRYPTED_UPLOAD_MAX_BYTES + 1;
    assert_eq!(
        s.encrypted_upload_start(TOKEN, &o, &c, &file).await,
        Err(AttachmentError::Invalid)
    );
}

#[tokio::test]
async fn encryption_required_even_on_fresh_install_and_ids_cannot_be_rebound() {
    let (s, o, c, _d) = fixture().await;
    let file = EncryptedUploadStart {
        upload_id: Uuid::new_v4(),
        filename: "file.txt".into(),
        media_type: "text/plain".into(),
        plaintext_size: 1,
    };
    assert_eq!(
        s.encrypted_upload_start(TOKEN, &o, &c, &file).await,
        Err(AttachmentError::EncryptionKeyRequired)
    );
    let (_, key) = identity();
    s.import_attachment_recipients(
        &o,
        &[ImportedRecipient {
            recipient: key,
            label: "Browser".into(),
            verified_at: 1,
        }],
    )
    .await
    .unwrap();
    s.encrypted_upload_start(TOKEN, &o, &c, &file)
        .await
        .unwrap();
    let mut changed = file.clone();
    changed.filename = "different.txt".into();
    assert_eq!(
        s.encrypted_upload_start(TOKEN, &o, &c, &changed).await,
        Err(AttachmentError::Conflict)
    );
}

#[tokio::test]
async fn removing_a_partial_upload_drops_its_ciphertext_and_frees_its_open_slot_at_once() {
    let (s, o, c, _d, mut file, key) = setup(ENCRYPTED_UPLOAD_CHUNK_BYTES + 3).await;
    // Eight unfinished uploads fill the owner's open sessions.
    let mut open = vec![];
    for _ in 0..8 {
        file.upload_id = Uuid::new_v4();
        s.encrypted_upload_start(TOKEN, &o, &c, &file)
            .await
            .unwrap();
        open.push(file.upload_id);
    }
    let (cancelled, other) = (open[0], open[1]);
    let first = seal::encrypt(
        std::slice::from_ref(&key),
        &vec![7; ENCRYPTED_UPLOAD_CHUNK_BYTES as usize],
    )
    .unwrap();
    let digest = seal::sha256_hex(&first);
    for id in [cancelled, other] {
        s.encrypted_upload_put(TOKEN, &o, &c, id, 0, &digest, &first)
            .await
            .unwrap();
    }
    file.upload_id = Uuid::new_v4();
    assert_eq!(
        s.encrypted_upload_start(TOKEN, &o, &c, &file).await,
        Err(AttachmentError::Conflict)
    );
    s.encrypted_upload_remove(TOKEN, &o, &c, cancelled)
        .await
        .unwrap();
    let chunks = |id: Uuid| {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM encrypted_upload_chunks WHERE upload_id=?",
        )
        .bind(id.to_string())
        .fetch_one(&s.pool)
    };
    assert_eq!(
        chunks(cancelled).await.unwrap(),
        0,
        "its ciphertext is gone"
    );
    assert_eq!(chunks(other).await.unwrap(), 1, "other uploads keep theirs");
    // A chunk still in flight at Cancel cannot revive or finish it.
    let last = seal::encrypt(&[key], b"end").unwrap();
    assert_eq!(
        s.encrypted_upload_put(TOKEN, &o, &c, cancelled, 1, &seal::sha256_hex(&last), &last)
            .await,
        Err(AttachmentError::NotFound)
    );
    assert_eq!(
        s.encrypted_upload_finish(TOKEN, &o, &c, cancelled, &[])
            .await,
        Err(AttachmentError::NotFound)
    );
    assert_eq!(
        s.encrypted_upload_remove(TOKEN, &o, &c, cancelled).await,
        Err(AttachmentError::NotFound)
    );
    assert_eq!(chunks(cancelled).await.unwrap(), 0);
    // Its open-session slot is free now, not after the 24 h expiry.
    assert!(s.encrypted_upload_start(TOKEN, &o, &c, &file).await.is_ok());
}
