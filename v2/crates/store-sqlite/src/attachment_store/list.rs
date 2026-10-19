use super::*;
impl Store {
    /// Exclusive UUID keyset; each page has its own authenticated read cut.
    pub async fn attachment_manifests_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        after_id: Option<Uuid>,
        limit: u16,
    ) -> Result<AttachmentManifestPage> {
        if limit == 0 || limit > 16 || after_id.is_some_and(|id| id.is_nil()) {
            return Err(AttachmentError::Invalid);
        }
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, false)
            .await?;
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM attachment_manifests WHERE owner_id=? AND conversation_id=? AND id>? ORDER BY id LIMIT ?",
        ).bind(owner.to_string()).bind(conversation.to_string())
            .bind(after_id.map(|id| id.to_string()).unwrap_or_default())
            .bind(i64::from(limit)+1).fetch_all(&mut *tx).await.map_err(db)?;
        let more = ids.len() > usize::from(limit);
        let mut manifests = Vec::new();
        for id in ids.iter().take(usize::from(limit)) {
            manifests.push(
                super::read::manifest_in(
                    &mut tx,
                    owner,
                    conversation,
                    Uuid::parse_str(id).map_err(db)?,
                )
                .await?,
            );
        }
        let next_after_id = if more {
            manifests.last().map(|m| m.manifest_id)
        } else {
            None
        };
        tx.commit().await.map_err(db)?;
        self.attachment_transaction(credential, owner, conversation, false)
            .await?
            .commit()
            .await
            .map_err(db)?;
        Ok(AttachmentManifestPage {
            owner_id: owner.clone(),
            conversation_id: conversation.clone(),
            after_id,
            next_after_id,
            manifests,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn authenticated_discovery_empty_paging_tombstone_and_revoke() {
        let (s, o, c, dir) = super::super::tests::fixture().await;
        let empty = s
            .attachment_manifests_authenticated("synthetic-token", &o, &c, None, 1)
            .await
            .unwrap();
        assert_eq!(empty.owner_id, o);
        assert_eq!(empty.conversation_id, c);
        assert!(empty.manifests.is_empty());
        let mut ids = Vec::new();
        for i in 0..3 {
            let mut r = super::super::tests::request(&o, &c);
            r.request_key = format!("list-{i}");
            let receipt = s
                .import_attachment_bundle_authenticated("synthetic-token", &o, &c, &r)
                .await
                .unwrap();
            ids.push(receipt.manifest.manifest_id);
        }
        ids.sort();
        let first = s
            .attachment_manifests_authenticated("synthetic-token", &o, &c, None, 2)
            .await
            .unwrap();
        assert_eq!(
            first
                .manifests
                .iter()
                .map(|m| m.manifest_id)
                .collect::<Vec<_>>(),
            ids[..2]
        );
        assert_eq!(first.next_after_id, Some(ids[1]));
        let last = s
            .attachment_manifests_authenticated("synthetic-token", &o, &c, first.next_after_id, 2)
            .await
            .unwrap();
        assert_eq!(last.manifests[0].manifest_id, ids[2]);
        assert_eq!(last.next_after_id, None);
        let r = &last.manifests[0].references[0];
        s.remove_attachment_authenticated(
            "synthetic-token",
            &o,
            &c,
            ids[2],
            r.reference_id,
            "remove-list",
        )
        .await
        .unwrap();
        assert_eq!(
            s.attachment_manifests_authenticated("synthetic-token", &o, &c, first.next_after_id, 2)
                .await
                .unwrap()
                .manifests[0]
                .references[0]
                .state,
            AttachmentState::Removed
        );
        assert_eq!(
            s.attachment_manifests_authenticated(
                "synthetic-token",
                &o,
                &ConversationId(Uuid::new_v4()),
                None,
                2
            )
            .await,
            Err(AttachmentError::NotFound)
        );
        assert_eq!(
            s.attachment_manifests_authenticated("synthetic-token", &o, &c, None, 17)
                .await,
            Err(AttachmentError::Invalid)
        );
        s.revoke_session("synthetic-token").await.unwrap();
        assert_eq!(
            s.attachment_manifests_authenticated("synthetic-token", &o, &c, None, 2)
                .await,
            Err(AttachmentError::Unauthorized)
        );
        s.pool.close().await;
        std::fs::remove_dir_all(dir).unwrap();
    }
}
