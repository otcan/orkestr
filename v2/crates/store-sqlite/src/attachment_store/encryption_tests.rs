//! Attachment objects at rest: sealing, fail-closed policy, recipient lifecycle.
use super::keys::ImportedRecipient;
use super::seal::testing::{decode_payload, decrypt, identity};
use super::seal::{fingerprint, sha256_hex};
use super::tests::{fixture, request};
use super::*;

const TOKEN: &str = "synthetic-token";

fn unbase64(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("not base64"),
    } as u32;
    let mut out = Vec::new();
    for chunk in text.trim_end_matches('=').as_bytes().chunks(4) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, c)| acc | (value(*c) << (18 - 6 * i)));
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}

/// Registers a fresh browser identity and answers its challenge.
async fn enroll(s: &Store, o: &OwnerId) -> (age::x25519::Identity, AttachmentRecipientRecord) {
    let (identity, recipient) = identity();
    let pending = s
        .register_attachment_recipient(
            TOKEN,
            o,
            &AttachmentRecipientRegistration {
                recipient,
                label: "Synthetic browser".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        pending.status,
        AttachmentRecipientStatus::PendingVerification
    );
    let challenge = pending.challenge.clone().unwrap();
    let proof = decrypt(&identity, &unbase64(&challenge.ciphertext_base64)).unwrap();
    let proof = String::from_utf8(proof).unwrap();
    assert!(proof.starts_with(super::seal::PROOF_PREFIX));
    let active = s
        .verify_attachment_recipient(TOKEN, o, pending.id, &proof)
        .await
        .unwrap();
    assert_eq!(active.status, AttachmentRecipientStatus::Active);
    assert!(active.challenge.is_none() && active.verified_at.is_some());
    (identity, active)
}

async fn plaintext_rows(s: &Store) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM attachment_objects WHERE bytes IS NOT NULL")
        .fetch_one(&s.pool)
        .await
        .unwrap()
}

fn opened(identity: &age::x25519::Identity, stored: &StoredObject) -> (serde_json::Value, Vec<u8>) {
    match stored {
        StoredObject::Sealed { ciphertext, .. } => {
            decode_payload(&decrypt(identity, ciphertext).expect("recipient decrypts")).unwrap()
        }
        StoredObject::Plain(_) => panic!("plaintext object stored"),
    }
}

#[tokio::test]
async fn enrolled_owner_stores_only_ciphertext_and_downloads_it() {
    let (s, o, c, d) = fixture().await;
    let (browser, key) = enroll(&s, &o).await;
    let r = request(&o, &c);
    let plain = r.source.contents[0].bytes.clone();
    s.import_attachment_bundle_authenticated(TOKEN, &o, &c, &r)
        .await
        .unwrap();
    assert_eq!(plaintext_rows(&s).await, 0);
    let m = r.target_manifest.manifest_id;
    let id = r.target_manifest.references[0].reference_id;
    let (reference, stored) = s
        .download_attachment_authenticated(TOKEN, &o, &c, m, id)
        .await
        .unwrap();
    assert_eq!(reference, r.target_manifest.references[0]);
    let StoredObject::Sealed {
        ciphertext,
        recipient_fingerprints,
    } = &stored
    else {
        panic!("expected ciphertext");
    };
    assert_eq!(recipient_fingerprints, &vec![key.fingerprint.clone()]);
    assert!(!ciphertext.windows(plain.len()).any(|w| w == plain));
    let (meta, content) = opened(&browser, &stored);
    assert_eq!(content, plain);
    assert_eq!(meta["filename"], "sample.bin");
    assert_eq!(meta["mimetype"], "application/octet-stream");
    assert_eq!(meta["plaintextChecksum"], reference.sha256);
    let bundle = s
        .export_attachment_bundle_authenticated(TOKEN, &o, &c, m)
        .await
        .unwrap();
    assert_eq!(
        bundle.contents[0].format,
        StoredAttachmentFormat::AgeX25519V1
    );
    assert_eq!(&bundle.contents[0].bytes, ciphertext);
    // No plaintext anywhere in the database files after a checkpoint.
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&s.pool)
        .await
        .unwrap();
    for entry in std::fs::read_dir(&d).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(!bytes.windows(plain.len()).any(|w| w == plain));
    }
    let status = s.attachment_encryption_status(TOKEN, &o).await.unwrap();
    assert!(status.ready);
    assert_eq!((status.plaintext_objects, status.sealed_objects), (0, 1));
    // Corrupted ciphertext is refused, removal deletes it.
    sqlx::query("UPDATE attachment_sealed_objects SET ciphertext_sha256=? WHERE reference_id=?")
        .bind("0".repeat(64))
        .bind(id.to_string())
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        s.download_attachment_authenticated(TOKEN, &o, &c, m, id)
            .await
            .err(),
        Some(AttachmentError::Unavailable)
    );
    s.remove_attachment_authenticated(TOKEN, &o, &c, m, id, "remove")
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM attachment_sealed_objects")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
    s.close().await;
    std::fs::remove_dir_all(d).unwrap();
}

#[tokio::test]
async fn required_policy_fails_closed_without_an_active_recipient() {
    let (s, o, c, d) = fixture().await;
    assert_eq!(
        s.set_attachment_encryption_policy(TOKEN, &o, true)
            .await
            .err(),
        Some(AttachmentError::EncryptionKeyRequired)
    );
    let (_, key) = enroll(&s, &o).await;
    assert!(
        s.set_attachment_encryption_policy(TOKEN, &o, true)
            .await
            .unwrap()
            .required
    );
    s.revoke_attachment_recipient(TOKEN, &o, key.id, "lost browser")
        .await
        .unwrap();
    let before = super::tests::audit(&s).await;
    let r = request(&o, &c);
    assert_eq!(
        s.import_attachment_bundle_authenticated(TOKEN, &o, &c, &r)
            .await
            .err(),
        Some(AttachmentError::EncryptionKeyRequired)
    );
    assert_eq!(super::tests::audit(&s).await, before);
    // Metadata-only (inert) copies carry no bytes and stay allowed.
    let mut inert = request(&o, &c);
    inert.request_key = "inert".into();
    inert.source.contents.clear();
    for m in [&mut inert.source.manifest, &mut inert.target_manifest] {
        m.references[0].state = AttachmentState::Inert;
    }
    s.import_attachment_bundle_authenticated(TOKEN, &o, &c, &inert)
        .await
        .unwrap();
    let status = s.attachment_encryption_status(TOKEN, &o).await.unwrap();
    assert!(status.required && !status.ready);
    assert_eq!(
        status.keys[0].revoked_reason.as_deref(),
        Some("lost browser")
    );
    s.close().await;
    std::fs::remove_dir_all(d).unwrap();
}

#[tokio::test]
async fn revoked_recipient_is_excluded_from_new_objects() {
    let (s, o, c, d) = fixture().await;
    let (first, first_key) = enroll(&s, &o).await;
    let (second, second_key) = enroll(&s, &o).await;
    let r = request(&o, &c);
    s.import_attachment_bundle_authenticated(TOKEN, &o, &c, &r)
        .await
        .unwrap();
    let (_, both) = s
        .download_attachment_authenticated(
            TOKEN,
            &o,
            &c,
            r.target_manifest.manifest_id,
            r.target_manifest.references[0].reference_id,
        )
        .await
        .unwrap();
    opened(&first, &both);
    opened(&second, &both);
    s.revoke_attachment_recipient(TOKEN, &o, first_key.id, "")
        .await
        .unwrap();
    let mut later = request(&o, &c);
    later.request_key = "later".into();
    s.import_attachment_bundle_authenticated(TOKEN, &o, &c, &later)
        .await
        .unwrap();
    let (_, stored) = s
        .download_attachment_authenticated(
            TOKEN,
            &o,
            &c,
            later.target_manifest.manifest_id,
            later.target_manifest.references[0].reference_id,
        )
        .await
        .unwrap();
    let StoredObject::Sealed {
        ciphertext,
        recipient_fingerprints,
    } = &stored
    else {
        panic!("expected ciphertext");
    };
    assert_eq!(recipient_fingerprints, &vec![second_key.fingerprint]);
    assert!(decrypt(&first, ciphertext).is_none());
    opened(&second, &stored);
    // Re-registering an active key is idempotent; a revoked one needs a new proof.
    let again = s
        .register_attachment_recipient(
            TOKEN,
            &o,
            &AttachmentRecipientRegistration {
                recipient: first_key.recipient.clone(),
                label: String::new(),
            },
        )
        .await
        .unwrap();
    assert_eq!(again.id, first_key.id);
    assert_eq!(again.status, AttachmentRecipientStatus::PendingVerification);
    s.close().await;
    std::fs::remove_dir_all(d).unwrap();
}

#[tokio::test]
async fn challenge_proof_is_checked_bounded_and_owner_scoped() {
    let (s, o, _, d) = fixture().await;
    let (_, recipient) = identity();
    let invalid = AttachmentRecipientRegistration {
        recipient: "age1notakey".into(),
        label: String::new(),
    };
    assert_eq!(
        s.register_attachment_recipient(TOKEN, &o, &invalid)
            .await
            .err(),
        Some(AttachmentError::Invalid)
    );
    let registration = AttachmentRecipientRegistration {
        recipient: recipient.clone(),
        label: "Phone\n".into(),
    };
    let pending = s
        .register_attachment_recipient(TOKEN, &o, &registration)
        .await
        .unwrap();
    assert_eq!(pending.label, "Phone");
    assert_eq!(pending.fingerprint, fingerprint(&recipient));
    assert_eq!(
        s.verify_attachment_recipient(TOKEN, &OwnerId(Uuid::new_v4()), pending.id, "x")
            .await
            .err(),
        Some(AttachmentError::Unauthorized)
    );
    for _ in 0..5 {
        assert_eq!(
            s.verify_attachment_recipient(TOKEN, &o, pending.id, "wrong")
                .await
                .err(),
            Some(AttachmentError::Invalid)
        );
    }
    assert_eq!(
        s.verify_attachment_recipient(TOKEN, &o, pending.id, "wrong")
            .await
            .err(),
        Some(AttachmentError::Conflict)
    );
    // A new registration issues a fresh challenge; an expired one is refused.
    let renewed = s
        .register_attachment_recipient(TOKEN, &o, &registration)
        .await
        .unwrap();
    assert_ne!(renewed.challenge, pending.challenge);
    sqlx::query("UPDATE attachment_recipients SET challenge_expires_at=unixepoch()-1")
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        s.verify_attachment_recipient(TOKEN, &o, renewed.id, "anything")
            .await
            .err(),
        Some(AttachmentError::Conflict)
    );
    let stored_hash: String =
        sqlx::query_scalar("SELECT challenge_nonce_hash FROM attachment_recipients")
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(stored_hash.len(), 64);
    assert_ne!(stored_hash, sha256_hex(b""));
    s.revoke_session(TOKEN).await.unwrap();
    assert_eq!(
        s.attachment_encryption_status(TOKEN, &o).await.err(),
        Some(AttachmentError::Unauthorized)
    );
    s.close().await;
    std::fs::remove_dir_all(d).unwrap();
}

#[tokio::test]
async fn legacy_plaintext_is_sealed_by_v1_import_and_enrollment() {
    let (s, o, c, d) = fixture().await;
    let r = request(&o, &c);
    s.import_attachment_bundle_authenticated(TOKEN, &o, &c, &r)
        .await
        .unwrap();
    assert_eq!(plaintext_rows(&s).await, 1);
    assert_eq!(s.seal_plaintext_attachments().await.unwrap(), 0);
    let (v1_browser, v1_recipient) = identity();
    let imported = vec![ImportedRecipient {
        recipient: v1_recipient.clone(),
        label: "Automatic WebUI browser".into(),
        verified_at: 1_756_764_588,
    }];
    assert_eq!(
        s.import_attachment_recipients(
            &o,
            &[ImportedRecipient {
                recipient: "age1bad".into(),
                label: String::new(),
                verified_at: 1
            }]
        )
        .await
        .err(),
        Some(AttachmentError::Invalid)
    );
    assert_eq!(
        s.import_attachment_recipients(&o, &imported).await.unwrap(),
        1
    );
    assert_eq!(
        s.import_attachment_recipients(&o, &imported).await.unwrap(),
        0
    );
    assert_eq!(plaintext_rows(&s).await, 0);
    let status = s.attachment_encryption_status(TOKEN, &o).await.unwrap();
    assert!(status.required && status.ready);
    assert_eq!(status.keys[0].origin, AttachmentRecipientOrigin::V1Import);
    assert_eq!(status.keys[0].verified_at, Some(1_756_764_588));
    assert_eq!((status.plaintext_objects, status.sealed_objects), (0, 1));
    let (_, stored) = s
        .download_attachment_authenticated(
            TOKEN,
            &o,
            &c,
            r.target_manifest.manifest_id,
            r.target_manifest.references[0].reference_id,
        )
        .await
        .unwrap();
    assert_eq!(opened(&v1_browser, &stored).1, r.source.contents[0].bytes);

    // The startup sweep seals residue written while no recipient was active.
    let (s2, o2, c2, d2) = fixture().await;
    let r2 = request(&o2, &c2);
    s2.import_attachment_bundle_authenticated(TOKEN, &o2, &c2, &r2)
        .await
        .unwrap();
    let (browser, _) = enroll(&s2, &o2).await; // verification seals it
    assert_eq!(plaintext_rows(&s2).await, 0);
    sqlx::query("UPDATE attachment_objects SET bytes=? WHERE 1")
        .bind(r2.source.contents[0].bytes.clone())
        .execute(&s2.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM attachment_sealed_objects")
        .execute(&s2.pool)
        .await
        .unwrap();
    assert_eq!(s2.seal_plaintext_attachments().await.unwrap(), 1);
    let (_, stored) = s2
        .download_attachment_authenticated(
            TOKEN,
            &o2,
            &c2,
            r2.target_manifest.manifest_id,
            r2.target_manifest.references[0].reference_id,
        )
        .await
        .unwrap();
    assert_eq!(opened(&browser, &stored).1, r2.source.contents[0].bytes);
    for (store, dir) in [(s, d), (s2, d2)] {
        store.close().await;
        std::fs::remove_dir_all(dir).unwrap();
    }
}
