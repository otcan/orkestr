//! Agent reply attachments (ORK-779): grant, running Deep turn, own
//! conversation, idempotency, and owner-side provenance.
use super::super::tests::{setup, Case};
use super::super::thread_asks::tests::{asking_turn, conversation};
use super::*;
use crate::attachment_store::AttachmentError;
use orkestr_v2_contracts::{
    AttachmentBundle, AttachmentContent, AttachmentImportRequest, AttachmentManifest,
    AttachmentReference, AttachmentReferenceMapping, AttachmentState, OwnerId,
    AGENT_ATTACHMENT_REQUEST_PREFIX,
};
use sha2::{Digest, Sha256};

async fn grant(f: &Case, c: &ConversationId) -> String {
    f.store
        .issue_agent_timer_grant(&f.token, &f.owner, c)
        .await
        .unwrap()
        .grant
}

/// The import the server builds for one uploaded workspace file.
fn upload(owner: &OwnerId, c: &ConversationId, key: &str, bytes: &[u8]) -> AttachmentImportRequest {
    let derived = |label: &str| {
        let digest = Sha256::digest(format!("synthetic\0{c}\0{key}\0{label}"));
        let mut id = [0u8; 16];
        id.copy_from_slice(&digest[..16]);
        uuid::Builder::from_random_bytes(id).into_uuid()
    };
    let reference = |id: Uuid| AttachmentReference {
        reference_id: id,
        message_id: None,
        filename: "October package.zip".into(),
        media_type: "application/zip".into(),
        byte_length: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        state: AttachmentState::Available,
    };
    let (source, target) = (
        reference(derived("source-0")),
        reference(derived("target-0")),
    );
    AttachmentImportRequest {
        request_key: format!("{AGENT_ATTACHMENT_REQUEST_PREFIX}{key}"),
        source: AttachmentBundle {
            manifest: AttachmentManifest {
                schema_version: 1,
                manifest_id: derived("source-manifest"),
                owner_id: owner.clone(),
                conversation_id: ConversationId(derived("source-conversation")),
                references: vec![source.clone()],
            },
            contents: vec![AttachmentContent {
                reference_id: source.reference_id,
                bytes: bytes.to_vec(),
            }],
        },
        target_manifest: AttachmentManifest {
            schema_version: 1,
            manifest_id: derived("target-manifest"),
            owner_id: owner.clone(),
            conversation_id: c.clone(),
            references: vec![target.clone()],
        },
        mapping: vec![AttachmentReferenceMapping {
            source_reference_id: source.reference_id,
            target_reference_id: target.reference_id,
        }],
    }
}

#[tokio::test]
async fn a_running_deep_turn_attaches_files_to_its_own_conversation_only() {
    let f = setup().await;
    let c = f.conversation.clone();
    let other = conversation(&f, "Other").await;
    let request = upload(&f.owner, &c, "k1", b"PK\x03\x04synthetic zip");
    // No grant: nothing is stored.
    assert_eq!(
        f.store.agent_attachment_owner(&"0".repeat(64), &c).await,
        Err(ResourceError::Unauthorized)
    );
    let g = grant(&f, &c).await;
    // The grant is only this conversation's.
    assert_eq!(
        f.store.agent_attachment_owner(&g, &other).await,
        Err(ResourceError::Unauthorized)
    );
    // Without a running Deep turn the grant does nothing.
    assert_eq!(
        f.store.import_agent_attachments(&g, &c, &request).await,
        Err(ResourceError::Conflict("agent_attachment_no_running_turn"))
    );
    asking_turn(&f, &c, "turn").await;
    assert_eq!(
        f.store.agent_attachment_owner(&g, &c).await,
        Ok(f.owner.clone())
    );
    // A manifest naming another conversation is refused, whatever the grant.
    let elsewhere = upload(&f.owner, &other, "k1", b"PK\x03\x04synthetic zip");
    assert_eq!(
        f.store.import_agent_attachments(&g, &c, &elsewhere).await,
        Err(ResourceError::NotFound)
    );
    // Only agent request keys are accepted on this path.
    let mut unmarked = request.clone();
    unmarked.request_key = "ui-attach-k1".into();
    assert_eq!(
        f.store.import_agent_attachments(&g, &c, &unmarked).await,
        Err(ResourceError::Invalid)
    );
    let (receipt, replayed) = f
        .store
        .import_agent_attachments(&g, &c, &request)
        .await
        .unwrap();
    assert!(!replayed);
    assert_eq!(receipt.manifest, request.target_manifest);
    // A retry with the same key stores nothing new and returns the same files.
    let (again, replayed) = f
        .store
        .import_agent_attachments(&g, &c, &request)
        .await
        .unwrap();
    assert!(replayed);
    assert_eq!(again, receipt);
    let imports: i64 = sqlx::query_scalar("SELECT count(*) FROM attachment_imports")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(imports, 1);
    // The same key for other bytes is a conflict, never a second file.
    let changed = upload(&f.owner, &c, "k1", b"other bytes");
    assert_eq!(
        f.store.import_agent_attachments(&g, &c, &changed).await,
        Err(ResourceError::Conflict("agent_attachment_conflict"))
    );
    // The owner reads it as an agent attachment of this conversation.
    let manifest = f
        .store
        .agent_attachment_manifest_authenticated(
            &f.token,
            &f.owner,
            &c,
            receipt.manifest.manifest_id,
        )
        .await
        .unwrap();
    assert_eq!(manifest.references, request.target_manifest.references);
    assert_eq!(
        f.store
            .agent_attachment_manifest_authenticated(
                &f.token,
                &f.owner,
                &other,
                receipt.manifest.manifest_id
            )
            .await,
        Err(AttachmentError::NotFound)
    );
    // A revoked grant stops at once.
    f.store
        .revoke_agent_timer_grant(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert_eq!(
        f.store.import_agent_attachments(&g, &c, &request).await,
        Err(ResourceError::Unauthorized)
    );
}

#[tokio::test]
async fn owner_uploads_are_never_agent_attachments() {
    let f = setup().await;
    let c = f.conversation.clone();
    let mut owner_upload = upload(&f.owner, &c, "owner", b"owner bytes");
    owner_upload.request_key = "ui-attach-owner".into();
    let receipt = f
        .store
        .import_attachment_bundle_authenticated(&f.token, &f.owner, &c, &owner_upload)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .agent_attachment_manifest_authenticated(
                &f.token,
                &f.owner,
                &c,
                receipt.manifest.manifest_id
            )
            .await,
        Err(AttachmentError::NotFound)
    );
    // The ordinary manifest read still sees it.
    assert!(f
        .store
        .attachment_manifest_authenticated(&f.token, &f.owner, &c, receipt.manifest.manifest_id)
        .await
        .is_ok());
}
