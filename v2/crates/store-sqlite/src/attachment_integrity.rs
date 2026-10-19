//! Pure integrity checks; callers must separately authenticate every storage operation.
use orkestr_v2_contracts::{AttachmentManifest, AttachmentState, ConversationId, OwnerId};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq)]
pub enum AttachmentIntegrityError {
    Invalid,
    Scope,
    Missing,
    Removed,
    Length,
    Digest,
    Mapping,
}

pub fn validate_attachment_bytes(
    manifest: &AttachmentManifest,
    owner: &OwnerId,
    conversation: &ConversationId,
    reference: Uuid,
    bytes: Option<&[u8]>,
) -> Result<(), AttachmentIntegrityError> {
    use AttachmentIntegrityError::*;
    if !manifest.is_valid() {
        return Err(Invalid);
    }
    if &manifest.owner_id != owner || &manifest.conversation_id != conversation {
        return Err(Scope);
    }
    let r = manifest
        .references
        .iter()
        .find(|r| r.reference_id == reference)
        .ok_or(Missing)?;
    if matches!(r.state, AttachmentState::Removed | AttachmentState::Inert) {
        return if bytes.is_none() {
            Ok(())
        } else {
            Err(Removed)
        };
    }
    let bytes = bytes.ok_or(Missing)?;
    if bytes.len() as u64 != r.byte_length {
        return Err(Length);
    }
    if format!("{:x}", Sha256::digest(bytes)) != r.sha256 {
        return Err(Digest);
    }
    Ok(())
}

/// Validates a complete copy-only mapping. Does not persist or authorize an import.
/// Message IDs must be separately mapped by a future authenticated importer.
pub fn validate_attachment_copy(
    source: &AttachmentManifest,
    target: &AttachmentManifest,
    mapping: &[(Uuid, Uuid)],
) -> Result<(), AttachmentIntegrityError> {
    use AttachmentIntegrityError::*;
    if !source.is_valid() || !target.is_valid() {
        return Err(Invalid);
    }
    if source.manifest_id == target.manifest_id
        || source.references.len() != target.references.len()
        || mapping.len() != source.references.len()
    {
        return Err(Mapping);
    }
    let source_ids: std::collections::HashSet<_> =
        source.references.iter().map(|r| r.reference_id).collect();
    let mut seen_source = std::collections::HashSet::new();
    let mut seen_target = std::collections::HashSet::new();
    for (old, new) in mapping {
        if source_ids.contains(new) || !seen_source.insert(*old) || !seen_target.insert(*new) {
            return Err(Mapping);
        }
        let a = source
            .references
            .iter()
            .find(|r| r.reference_id == *old)
            .ok_or(Mapping)?;
        let b = target
            .references
            .iter()
            .find(|r| r.reference_id == *new)
            .ok_or(Mapping)?;
        if a.filename != b.filename
            || a.media_type != b.media_type
            || a.byte_length != b.byte_length
            || a.sha256 != b.sha256
            || a.state != b.state
            || b.message_id.is_some()
        {
            return Err(Mapping);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use orkestr_v2_contracts::AttachmentReference;
    fn manifest(bytes: &[u8]) -> AttachmentManifest {
        AttachmentManifest {
            schema_version: 1,
            manifest_id: Uuid::new_v4(),
            owner_id: OwnerId(Uuid::new_v4()),
            conversation_id: ConversationId(Uuid::new_v4()),
            references: vec![AttachmentReference {
                reference_id: Uuid::new_v4(),
                message_id: None,
                filename: "sample.txt".into(),
                media_type: "text/plain".into(),
                byte_length: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
                state: AttachmentState::Available,
            }],
        }
    }
    #[test]
    fn integrity_and_scope() {
        for bytes in [b"".as_slice(), b"synthetic"] {
            let m = manifest(bytes);
            let id = m.references[0].reference_id;
            let check = |b| validate_attachment_bytes(&m, &m.owner_id, &m.conversation_id, id, b);
            assert_eq!(check(Some(bytes)), Ok(()));
            assert_eq!(check(None), Err(AttachmentIntegrityError::Missing));
            assert_eq!(
                check(Some(b"wrong length")),
                Err(AttachmentIntegrityError::Length)
            );
            assert_eq!(
                validate_attachment_bytes(
                    &m,
                    &OwnerId(Uuid::new_v4()),
                    &m.conversation_id,
                    id,
                    Some(bytes)
                ),
                Err(AttachmentIntegrityError::Scope)
            );
        }
        let m = manifest(b"abc");
        assert_eq!(
            validate_attachment_bytes(
                &m,
                &m.owner_id,
                &m.conversation_id,
                m.references[0].reference_id,
                Some(b"abd")
            ),
            Err(AttachmentIntegrityError::Digest)
        );
    }
    #[test]
    fn metadata_duplicates_and_tombstones() {
        let mut m = manifest(b"abc");
        for name in ["../x", "a\\b", "a:b", "\n", ".", ""] {
            m.references[0].filename = name.into();
            assert!(!m.is_valid());
        }
        m.references[0].filename = "safe.txt".into();
        m.references[0].state = AttachmentState::Removed;
        let id = m.references[0].reference_id;
        assert_eq!(
            validate_attachment_bytes(&m, &m.owner_id, &m.conversation_id, id, None),
            Ok(())
        );
        assert_eq!(
            validate_attachment_bytes(&m, &m.owner_id, &m.conversation_id, id, Some(b"abc")),
            Err(AttachmentIntegrityError::Removed)
        );
        m.references.push(m.references[0].clone());
        assert!(!m.is_valid());
    }
    #[test]
    fn copy_mapping_is_complete_and_immutable() {
        let a = manifest(b"abc");
        let mut b = a.clone();
        b.manifest_id = Uuid::new_v4();
        b.owner_id = OwnerId(Uuid::new_v4());
        b.conversation_id = ConversationId(Uuid::new_v4());
        b.references[0].reference_id = Uuid::new_v4();
        let mapping = [(a.references[0].reference_id, b.references[0].reference_id)];
        assert_eq!(validate_attachment_copy(&a, &b, &mapping), Ok(()));
        assert_eq!(
            validate_attachment_copy(&a, &b, &[]),
            Err(AttachmentIntegrityError::Mapping)
        );
        b.references[0].sha256 = "0".repeat(64);
        assert_eq!(
            validate_attachment_copy(&a, &b, &mapping),
            Err(AttachmentIntegrityError::Mapping)
        );
    }
}
