//! Browser password rotation never revokes separately issued machine sessions.
use super::*;

#[derive(Debug, PartialEq, Eq)]
pub enum PasswordChange {
    Changed,
    Unauthorized,
    LegacySessions,
    CredentialsChanged,
}

impl Store {
    /// Local operator recovery port. Never expose this as an HTTP operation.
    /// The executable caller must enforce privileged custody before opening Core.
    pub async fn recover_owner_password(
        &self,
        username: &str,
        replacement_hash: &str,
        revoke_legacy: bool,
    ) -> Result<PasswordChange> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner: Option<String> = sqlx::query_scalar("SELECT id FROM owners WHERE username=?")
            .bind(username)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        let owner = owner.ok_or(StoreError::NotFound)?;
        let legacy: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE owner_id=? AND kind='legacy' AND expires_at>unixepoch()")
            .bind(&owner).fetch_one(&mut *tx).await.map_err(db)?;
        if legacy != 0 && !revoke_legacy {
            return Ok(PasswordChange::LegacySessions);
        }
        sqlx::query("UPDATE owners SET password_hash=? WHERE id=?")
            .bind(replacement_hash)
            .bind(&owner)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM auth_sessions WHERE owner_id=? AND kind IN ('browser','legacy')")
            .bind(owner)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(PasswordChange::Changed)
    }

    /// Revalidate the authenticated browser and verified password under the write lock.
    /// A legacy session's transport is unknowable from its hash. Refuse rotation
    /// until those sessions expire rather than silently retaining browser access
    /// or revoking a running machine consumer.
    pub async fn change_owner_password(
        &self,
        browser_credential: &str,
        expected_hash: &str,
        replacement_hash: &str,
    ) -> Result<PasswordChange> {
        if !browser_credential.starts_with("browser:") {
            return Ok(PasswordChange::Unauthorized);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner: Option<String> = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND kind='browser' AND expires_at>unixepoch()",
        )
        .bind(digest(browser_credential)).fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(owner) = owner else {
            return Ok(PasswordChange::Unauthorized);
        };
        let legacy: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM auth_sessions WHERE owner_id=? AND kind='legacy' AND expires_at>unixepoch()",
        ).bind(&owner).fetch_one(&mut *tx).await.map_err(db)?;
        if legacy != 0 {
            return Ok(PasswordChange::LegacySessions);
        }
        let changed =
            sqlx::query("UPDATE owners SET password_hash=? WHERE id=? AND password_hash=?")
                .bind(replacement_hash)
                .bind(&owner)
                .bind(expected_hash)
                .execute(&mut *tx)
                .await
                .map_err(db)?
                .rows_affected();
        if changed != 1 {
            return Ok(PasswordChange::CredentialsChanged);
        }
        sqlx::query("DELETE FROM auth_sessions WHERE owner_id=? AND kind='browser'")
            .bind(owner)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(PasswordChange::Changed)
    }

    /// Fence login's password verification against a concurrent password change.
    pub async fn save_verified_session(
        &self,
        token: &str,
        owner: &OwnerId,
        expected_hash: &str,
    ) -> Result<bool> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let current: Option<String> =
            sqlx::query_scalar("SELECT password_hash FROM owners WHERE id=?")
                .bind(owner.to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
        if current.as_deref() != Some(expected_hash) {
            return Ok(false);
        }
        let kind = if token.starts_with("browser:") {
            "browser"
        } else {
            "machine"
        };
        sqlx::query("DELETE FROM auth_sessions WHERE expires_at<=unixepoch()")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,expires_at,kind) VALUES(?,?,unixepoch()+43200,?)")
            .bind(digest(token)).bind(owner.to_string()).bind(kind)
            .execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rotation_revokes_browsers_preserves_machines_and_fences_stale_verification() {
        let home = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
        std::fs::create_dir_all(&home).unwrap();
        let path = home.join(format!("password-{}.sqlite3", Uuid::new_v4()));
        let store = Store::open(&path).await.unwrap();
        store.setup("synthetic-owner", "old-hash").await.unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        store.save_session("browser:current", &owner).await.unwrap();
        store.save_session("browser:other", &owner).await.unwrap();
        store.save_session("machine", &owner).await.unwrap();
        assert_eq!(
            store
                .change_owner_password("machine", "old-hash", "new-hash")
                .await
                .unwrap(),
            PasswordChange::Unauthorized
        );
        assert_eq!(
            store
                .change_owner_password("browser:current", "stale-hash", "new-hash")
                .await
                .unwrap(),
            PasswordChange::CredentialsChanged
        );
        sqlx::query("UPDATE auth_sessions SET kind='legacy' WHERE token_hash=?")
            .bind(digest("machine"))
            .execute(&store.pool)
            .await
            .unwrap();
        assert_eq!(
            store
                .change_owner_password("browser:current", "old-hash", "new-hash")
                .await
                .unwrap(),
            PasswordChange::LegacySessions
        );
        assert!(store.authenticate("browser:other").await.unwrap().is_some());
        sqlx::query("UPDATE auth_sessions SET kind='machine' WHERE token_hash=?")
            .bind(digest("machine"))
            .execute(&store.pool)
            .await
            .unwrap();
        assert_eq!(
            store
                .change_owner_password("browser:current", "old-hash", "new-hash")
                .await
                .unwrap(),
            PasswordChange::Changed
        );
        assert!(store
            .authenticate("browser:current")
            .await
            .unwrap()
            .is_none());
        assert!(store.authenticate("browser:other").await.unwrap().is_none());
        assert!(store.authenticate("machine").await.unwrap().is_some());
        assert_eq!(
            store
                .credentials("synthetic-owner")
                .await
                .unwrap()
                .unwrap()
                .1,
            "new-hash"
        );
        assert!(!store
            .save_verified_session("browser:late-login", &owner, "old-hash")
            .await
            .unwrap());
        assert!(store
            .save_verified_session("browser:new-login", &owner, "new-hash")
            .await
            .unwrap());
        assert_eq!(
            store
                .recover_owner_password("synthetic-owner", "recovered-hash", false)
                .await
                .unwrap(),
            PasswordChange::Changed
        );
        assert!(store
            .authenticate("browser:new-login")
            .await
            .unwrap()
            .is_none());
        assert!(store.authenticate("machine").await.unwrap().is_some());
        store.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
