//! Independent synthetic pure-validator oracle, not storage/download acceptance.
use orkestr_v2_contracts::{
    AttachmentManifest, AttachmentState, ConversationId, MessageId, OwnerId,
};
use orkestr_v2_store_sqlite::attachment_integrity::{
    AttachmentIntegrityError as E, validate_attachment_bytes, validate_attachment_copy,
};
use uuid::Uuid;
fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}
fn source() -> AttachmentManifest {
    serde_json::from_str(include_str!("attachment-cases.json")).unwrap()
}
#[test]
fn independent_exact_bytes_scope_and_tombstone() {
    let m = source();
    let bytes: [&[u8]; 4] = [
        b"",
        &[0, 255, 128, 10, 13, 0],
        b"same\r\nbytes\n",
        b"same\r\nbytes\n",
    ];
    for (r, bytes) in m.references.iter().zip(bytes) {
        assert_eq!(
            validate_attachment_bytes(
                &m,
                &m.owner_id,
                &m.conversation_id,
                r.reference_id,
                Some(bytes)
            ),
            Ok(())
        );
        assert_eq!(
            validate_attachment_bytes(&m, &m.owner_id, &m.conversation_id, r.reference_id, None),
            Err(E::Missing)
        );
        let mut changed = bytes.to_vec();
        changed.push(0);
        assert_eq!(
            validate_attachment_bytes(
                &m,
                &m.owner_id,
                &m.conversation_id,
                r.reference_id,
                Some(&changed)
            ),
            Err(E::Length)
        );
    }
    let r = &m.references[1];
    assert_eq!(
        validate_attachment_bytes(
            &m,
            &m.owner_id,
            &m.conversation_id,
            r.reference_id,
            Some(&[0, 255, 128, 10, 13, 1])
        ),
        Err(E::Digest)
    );
    assert_eq!(
        validate_attachment_bytes(
            &m,
            &OwnerId(id(900)),
            &m.conversation_id,
            r.reference_id,
            Some(bytes[1])
        ),
        Err(E::Scope)
    );
    assert_eq!(
        validate_attachment_bytes(
            &m,
            &m.owner_id,
            &ConversationId(id(900)),
            r.reference_id,
            Some(bytes[1])
        ),
        Err(E::Scope)
    );
    assert_eq!(
        validate_attachment_bytes(&m, &m.owner_id, &m.conversation_id, id(900), None),
        Err(E::Missing)
    );
    let mut removed = m.clone();
    removed.references[1].state = AttachmentState::Removed;
    assert_eq!(
        validate_attachment_bytes(
            &removed,
            &m.owner_id,
            &m.conversation_id,
            r.reference_id,
            None
        ),
        Ok(())
    );
    assert_eq!(
        validate_attachment_bytes(
            &removed,
            &m.owner_id,
            &m.conversation_id,
            r.reference_id,
            Some(bytes[1])
        ),
        Err(E::Removed)
    );
}
#[test]
fn independent_bijection_and_metadata_refusals() {
    let a = source();
    let mut b = a.clone();
    b.manifest_id = id(100);
    b.owner_id = OwnerId(id(101));
    b.conversation_id = ConversationId(id(102));
    for (i, r) in b.references.iter_mut().enumerate() {
        r.reference_id = id(200 + i as u128);
        r.message_id = None;
    }
    let map: Vec<_> = a
        .references
        .iter()
        .zip(&b.references)
        .map(|(a, b)| (a.reference_id, b.reference_id))
        .collect();
    assert_eq!(validate_attachment_copy(&a, &b, &map), Ok(()));
    // Same bytes in two distinct references must retain both identities.
    assert_eq!(a.references[2].sha256, a.references[3].sha256);
    assert_eq!(validate_attachment_copy(&a, &b, &map[..3]), Err(E::Mapping));
    let mut repeated = map.clone();
    repeated[3] = repeated[2];
    assert_eq!(validate_attachment_copy(&a, &b, &repeated), Err(E::Mapping));
    let mut mutated = b.clone();
    mutated.references[0].filename = "changed.bin".into();
    assert_eq!(
        validate_attachment_copy(&a, &mutated, &map),
        Err(E::Mapping)
    );
    let mut mutated = b.clone();
    mutated.references[0].message_id = Some(MessageId(id(999)));
    assert_eq!(
        validate_attachment_copy(&a, &mutated, &map),
        Err(E::Mapping)
    );
    assert_eq!(validate_attachment_copy(&a, &a, &map), Err(E::Mapping));
    let mut duplicate = a.clone();
    duplicate.references.push(duplicate.references[0].clone());
    assert!(!duplicate.is_valid());
    for name in ["../escape", "a\\b", "a:b", ".", "\0", ""] {
        let mut x = a.clone();
        x.references[0].filename = name.into();
        assert!(!x.is_valid());
    }
    for media in [
        "text/plain; charset=utf-8",
        "text/",
        "text/plain/other",
        "téxt/plain",
    ] {
        let mut x = a.clone();
        x.references[0].media_type = media.into();
        assert!(!x.is_valid());
    }
    let mut x = a.clone();
    x.references[0].sha256 = "A".repeat(64);
    assert!(!x.is_valid());
    let mut x = a.clone();
    x.references[0].byte_length = 16 * 1024 * 1024;
    assert!(!x.is_valid()); // aggregate cap
    let mut x = a.clone();
    x.references[0].byte_length = 16 * 1024 * 1024 + 1;
    assert!(!x.is_valid());
    let mut x = a.clone();
    x.references[0].filename = "é".repeat(128);
    assert!(!x.is_valid());
    let mut x = a;
    x.references.clear();
    for n in 1..=129 {
        let mut r = b.references[0].clone();
        r.reference_id = id(1000 + n);
        r.byte_length = 0;
        x.references.push(r);
    }
    assert!(!x.is_valid());
}
