use super::*;
impl Store {
    /// Current authenticated selection, including the default-off state.
    pub async fn memory_settings_authenticated(&self, credential: &str) -> Result<MemorySettings> {
        let (mut tx, owner_id) = self.memory_transaction(credential, false, false).await?;
        let enabled: Option<i64> =
            sqlx::query_scalar("SELECT enabled FROM memory_settings WHERE owner_id=?")
                .bind(owner_id.to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(MemorySettings {
            owner_id,
            enabled: enabled == Some(1),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn default_selection_reload_disable_and_revocation_are_truthful() {
        let f = crate::memory::tests::fixture().await;
        let off = MemorySettings {
            owner_id: f.owner.clone(),
            enabled: false,
        };
        assert_eq!(
            f.store
                .memory_settings_authenticated(&f.credential)
                .await
                .unwrap(),
            off
        );
        crate::memory::tests::enabled(&f).await;
        let reopened = Store::open(&f.path).await.unwrap();
        assert!(
            reopened
                .memory_settings_authenticated(&f.credential)
                .await
                .unwrap()
                .enabled
        );
        reopened
            .set_memory_enabled_authenticated(&f.credential, false)
            .await
            .unwrap();
        assert_eq!(
            f.store
                .memory_settings_authenticated(&f.credential)
                .await
                .unwrap(),
            off
        );
        assert_eq!(
            f.store.memory_settings_authenticated("bare-machine").await,
            Err(MemoryError::Unauthorized)
        );
        f.store.revoke_session(&f.credential).await.unwrap();
        assert_eq!(
            reopened.memory_settings_authenticated(&f.credential).await,
            Err(MemoryError::Unauthorized)
        );
    }
}
