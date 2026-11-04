//! Separate, revocable credentials for unattended consumers of browser-shaped APIs.
use super::*;

#[derive(serde::Serialize)]
pub struct ServiceCredential {
    pub id: String,
    pub label: String,
    pub expires_at: i64,
    pub revoked: bool,
}


impl Store {
    pub async fn create_service_credential(
        &self,
        browser: &str,
        verified_hash: &str,
        label: &str,
        token: &str,
    ) -> Result<Option<String>> {
        if label.trim().is_empty() || label.len() > 128 || !browser.starts_with("browser:") {
            return Err(StoreError::Invalid);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner: Option<String> = sqlx::query_scalar("SELECT s.owner_id FROM auth_sessions s JOIN owners o ON o.id=s.owner_id WHERE s.token_hash=? AND s.kind='browser' AND s.expires_at>unixepoch() AND o.password_hash=?")
            .bind(digest(browser)).bind(verified_hash).fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(owner) = owner else {
            return Ok(None);
        };
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM service_credentials WHERE owner_id=? AND revoked=0 AND expires_at>unixepoch()")
            .bind(&owner).fetch_one(&mut *tx).await.map_err(db)?;
        if count >= 16 {
            return Err(StoreError::Conflict);
        }
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO service_credentials(id,owner_id,label,token_hash,expires_at) VALUES(?,?,?,?,unixepoch()+2592000)")
            .bind(&id).bind(owner).bind(label).bind(digest(token)).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(Some(id))
    }

    pub async fn exchange_service_session(
        &self,
        secret: &str,
        session: &str,
    ) -> Result<Option<OwnerId>> {
        if !session.starts_with("browser:") {
            return Err(StoreError::Invalid);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let key = sqlx::query("SELECT id,owner_id FROM service_credentials WHERE token_hash=? AND revoked=0 AND expires_at>unixepoch()")
            .bind(digest(secret)).fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(key) = key else {
            return Ok(None);
        };
        let id: String = key.get(0);
        let owner: String = key.get(1);
        // Consumers may overlap during a restart or use the same protected key.
        // Exchanging one cookie must not revoke another consumer's live cookie.
        sqlx::query("DELETE FROM auth_sessions WHERE expires_at<=unixepoch()")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let active: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM auth_sessions WHERE service_credential_id=? AND expires_at>unixepoch()",
        )
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        // The write transaction serializes the cap check with insertion. Reject
        // excess exchanges without evicting a cookie whose consumer still runs.
        if active >= 64 {
            return Err(StoreError::Conflict);
        }
        sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,expires_at,kind,service_credential_id) VALUES(?,?,min(unixepoch()+43200,(SELECT expires_at FROM service_credentials WHERE id=?)),'service_browser',?)")
            .bind(digest(session)).bind(&owner).bind(&id).bind(&id).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(Some(OwnerId(parse(owner)?)))
    }

    pub async fn service_credentials(&self, browser: &str) -> Result<Vec<ServiceCredential>> {
        let rows = sqlx::query("SELECT k.id,k.label,k.expires_at,k.revoked FROM service_credentials k JOIN auth_sessions s ON s.owner_id=k.owner_id WHERE s.token_hash=? AND s.kind='browser' AND s.expires_at>unixepoch() ORDER BY k.id")
            .bind(digest(browser)).fetch_all(&self.pool).await.map_err(db)?;
        Ok(rows
            .iter()
            .map(|r| ServiceCredential {
                id: r.get(0),
                label: r.get(1),
                expires_at: r.get(2),
                revoked: r.get(3),
            })
            .collect())
    }

    pub async fn revoke_service_credential(&self, browser: &str, id: &str) -> Result<bool> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let changed = sqlx::query("UPDATE service_credentials SET revoked=1 WHERE id=? AND owner_id=(SELECT owner_id FROM auth_sessions WHERE token_hash=? AND kind='browser' AND expires_at>unixepoch())")
            .bind(id).bind(digest(browser)).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed == 0 {
            return Ok(false);
        }
        sqlx::query("DELETE FROM auth_sessions WHERE service_credential_id=?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn service_credentials_survive_password_rotation_and_revoke_their_sessions() {
        let home = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
        std::fs::create_dir_all(&home).unwrap();
        let path = home.join(format!("service-auth-{}.sqlite3", Uuid::new_v4()));
        let store = Store::open(&path).await.unwrap();
        store.setup("synthetic-owner", "old-hash").await.unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        store.save_session("browser:human", &owner).await.unwrap();
        let secret = "a".repeat(64);
        assert!(store
            .create_service_credential("browser:human", "stale-hash", "adapter", &secret)
            .await
            .unwrap()
            .is_none());
        let id = store
            .create_service_credential("browser:human", "old-hash", "adapter", &secret)
            .await
            .unwrap()
            .unwrap();
        assert!(store
            .exchange_service_session(&"b".repeat(64), "browser:service")
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .exchange_service_session(&secret, "browser:service")
                .await
                .unwrap(),
            Some(owner.clone())
        );
        assert_eq!(
            store
                .change_owner_password("browser:service", "old-hash", "bad-change")
                .await
                .unwrap(),
            crate::owner_password::PasswordChange::Unauthorized
        );
        assert_eq!(
            store
                .change_owner_password("browser:human", "old-hash", "new-hash")
                .await
                .unwrap(),
            crate::owner_password::PasswordChange::Changed
        );
        assert!(store
            .authenticate("browser:service")
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            store
                .exchange_service_session(&secret, "browser:renewed")
                .await
                .unwrap(),
            Some(owner.clone())
        );
        assert!(store
            .authenticate("browser:service")
            .await
            .unwrap()
            .is_some());
        assert!(!store
            .revoke_service_credential("browser:service", &id)
            .await
            .unwrap());
        store
            .save_session("browser:human-new", &owner)
            .await
            .unwrap();
        let listing = store
            .service_credentials("browser:human-new")
            .await
            .unwrap();
        assert_eq!(listing.len(), 1);
        assert_eq!(listing[0].label, "adapter");
        assert!(store
            .revoke_service_credential("browser:human-new", &id)
            .await
            .unwrap());
        assert!(store
            .authenticate("browser:renewed")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .authenticate("browser:service")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .exchange_service_session(&secret, "browser:after-revoke")
            .await
            .unwrap()
            .is_none());
        store.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn shared_service_sessions_are_bounded_without_eviction_and_revoke_together() {
        let home = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
        std::fs::create_dir_all(&home).unwrap();
        let path = home.join(format!("service-session-cap-{}.sqlite3", Uuid::new_v4()));
        let store = Store::open(&path).await.unwrap();
        store.setup("synthetic-owner", "hash").await.unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        store.save_session("browser:human", &owner).await.unwrap();
        let secret = "c".repeat(64);
        let id = store
            .create_service_credential("browser:human", "hash", "shared adapter", &secret)
            .await
            .unwrap()
            .unwrap();
        for index in 0..64 {
            assert_eq!(
                store
                    .exchange_service_session(&secret, &format!("browser:shared-{index}"))
                    .await
                    .unwrap(),
                Some(owner.clone())
            );
        }
        assert!(matches!(
            store
                .exchange_service_session(&secret, "browser:excess")
                .await,
            Err(StoreError::Conflict)
        ));
        for index in 0..64 {
            assert!(store
                .authenticate(&format!("browser:shared-{index}"))
                .await
                .unwrap()
                .is_some());
        }
        assert!(store
            .authenticate("browser:excess")
            .await
            .unwrap()
            .is_none());
        // An expired cookie frees capacity; a new exchange never evicts a live one.
        sqlx::query("UPDATE auth_sessions SET expires_at=unixepoch()-1 WHERE token_hash=?")
            .bind(digest("browser:shared-0"))
            .execute(&store.pool)
            .await
            .unwrap();
        assert_eq!(
            store
                .exchange_service_session(&secret, "browser:replacement")
                .await
                .unwrap(),
            Some(owner)
        );
        let active: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE service_credential_id=? AND expires_at>unixepoch()")
            .bind(&id).fetch_one(&store.pool).await.unwrap();
        assert_eq!(active, 64);
        assert!(store
            .authenticate("browser:shared-0")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .revoke_service_credential("browser:human", &id)
            .await
            .unwrap());
        for index in 1..64 {
            assert!(store
                .authenticate(&format!("browser:shared-{index}"))
                .await
                .unwrap()
                .is_none());
        }
        assert!(store
            .authenticate("browser:replacement")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .exchange_service_session(&secret, "browser:revoked-key")
            .await
            .unwrap()
            .is_none());
        store.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
